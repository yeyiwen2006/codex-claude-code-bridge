import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { approvalText, cancelClaudeJob, describeClaudeJob, readClaudeJobResult, resolveClaudeApproval, startClaudeJob, waitForJobEvent } from "../server/lib/claude-job-manager.mjs";
import {
  loadSessionState,
  saveSessionState,
  sessionLockName,
  withStateLock,
} from "../server/lib/state-store.mjs";

const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const jobId = "a1b2c3d4";
const approvalId = "f0e1d2c3";
const orphanPid = 2147483647;

async function seedOrphan(dataRoot, overrides = {}) {
  const specPath = path.join(dataRoot, "jobs", sessionId, `${jobId}.json`);
  const imageDirectory = path.join(dataRoot, "images", sessionId);
  const resultDirectory = path.join(dataRoot, "results", sessionId);
  await Promise.all([
    mkdir(path.dirname(specPath), { recursive: true }),
    mkdir(imageDirectory, { recursive: true }),
    mkdir(resultDirectory, { recursive: true }),
  ]);
  const attached = path.join(imageDirectory, "attached.png");
  const queued = path.join(imageDirectory, "next.png");
  const oldResult = path.join(resultDirectory, "previous.md");
  const unfinishedResult = path.join(resultDirectory, `${jobId}.md`);
  await Promise.all([
    writeFile(attached, "attached fixture"), writeFile(queued, "next fixture"),
    writeFile(oldResult, "previous result", "utf8"),
    writeFile(unfinishedResult, "unconfirmed worker output", "utf8"),
    writeFile(specPath, JSON.stringify({ request: {
      taskPrompt: "Write the authorized fixture", authorizationRoot: dataRoot,
      imageIds: ["attached1"], input: { persistSession: false },
    } }), "utf8"),
  ]);
  await saveSessionState(dataRoot, sessionId, {
    images: [{ id: "attached1", storedPath: attached }, { id: "queued002", storedPath: queued }],
    resultFiles: [oldResult], forkNext: true,
    activeJob: { id: jobId, status: "running", workerPid: orphanPid, cancelRequested: true,
      pendingApproval: { id: approvalId, toolName: "Write" }, decision: { approvalId, action: "allow" } },
    ...overrides,
  });
  return { specPath, attached, queued, oldResult, unfinishedResult };
}

function stubOrphanProbe(probe) {
  const originalKill = process.kill;
  process.kill = (pid, signal) => pid === orphanPid ? probe(signal) : originalKill(pid, signal);
  return () => { process.kill = originalKill; };
}

test("recovers a stopped dead worker, retains unrelated images and exposes the cancelled result", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-dead-cancelled-"));
  const restore = stubOrphanProbe((signal) => { assert.equal(signal, 0); throw Object.assign(new Error("dead fixture"), { code: "ESRCH" }); });
  try {
    const files = await seedOrphan(dataRoot);
    assert.match(await describeClaudeJob({ dataRoot, sessionId }), /^cancelled/);
    const state = await loadSessionState(dataRoot, sessionId);
    assert.equal(state.activeJob.pendingApproval, null);
    assert.equal(state.activeJob.decision, null);
    assert.equal(state.forkNext, false);
    assert.deepEqual(state.images.map((image) => image.id), ["queued002"]);
    await assert.rejects(access(files.specPath));
    await assert.rejects(access(files.attached));
    await access(files.queued);
    assert.equal(await readFile(files.oldResult, "utf8"), "previous result");
    assert.equal(await readFile(files.unfinishedResult, "utf8"), "unconfirmed worker output");
    assert.ok(state.resultFiles.includes(files.unfinishedResult));
    assert.ok(state.resultFiles.includes(state.activeJob.resultPath));
    assert.equal(state.bridgeHistory.at(-1).status, "cancelled");
    const result = await readClaudeJobResult({ dataRoot, sessionId });
    assert.match(result, /任务已取消/);
    assert.doesNotMatch(result, /unconfirmed worker output/);
    assert.equal((await loadSessionState(dataRoot, sessionId)).activeJob, null);
  } finally { restore(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("wait polling finalizes an unexpectedly dead worker as failed", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-dead-failed-"));
  const restore = stubOrphanProbe(() => { throw Object.assign(new Error("dead fixture"), { code: "ESRCH" }); });
  try {
    await seedOrphan(dataRoot, { activeJob: { id: jobId, status: "waiting", workerPid: orphanPid, cancelRequested: false } });
    const text = await waitForJobEvent(dataRoot, sessionId, jobId, 0);
    assert.match(text, /任务失败/);
    const state = await loadSessionState(dataRoot, sessionId);
    assert.equal(state.activeJob, null);
    assert.equal(state.bridgeHistory.at(-1).status, "failed");
  } finally { restore(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("dead-worker recovery respects SessionEnd cleanup without recreating the session", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-dead-ended-"));
  const restore = stubOrphanProbe(() => { throw Object.assign(new Error("dead fixture"), { code: "ESRCH" }); });
  try {
    const files = await seedOrphan(dataRoot, { sessionEnded: true });
    assert.equal(await describeClaudeJob({ dataRoot, sessionId }), "无");
    for (const file of [...Object.values(files), path.join(dataRoot, "state", "sessions", `${sessionId}.json`)]) {
      await assert.rejects(access(file));
    }
    assert.deepEqual(await readdir(path.join(dataRoot, "results")), []);
  } finally { restore(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("does not reclaim unregistered, live, inaccessible or reused worker PIDs", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-worker-probe-"));
  let probe = () => true;
  const restore = stubOrphanProbe((signal) => { assert.equal(signal, 0); return probe(); });
  try {
    for (const workerPid of [null, 0, -1, "1234", process.pid, orphanPid]) {
      await saveSessionState(dataRoot, sessionId, { activeJob: { id: jobId, status: "starting", workerPid } });
      assert.match(await describeClaudeJob({ dataRoot, sessionId }), /^starting/);
    }
    probe = () => { throw Object.assign(new Error("inaccessible fixture"), { code: "EPERM" }); };
    assert.match(await describeClaudeJob({ dataRoot, sessionId }), /^starting/);
    let checks = 0;
    probe = () => {
      checks += 1;
      if (checks === 1) throw Object.assign(new Error("exited fixture"), { code: "ESRCH" });
      return true;
    };
    assert.match(await describeClaudeJob({ dataRoot, sessionId }), /^starting/);
    assert.equal(checks, 2, "recheck process existence after acquiring the state lock");
  } finally { restore(); await rm(dataRoot, { recursive: true, force: true }); }
});

for (const asynchronous of [false, true]) {
test(`marks a job failed and removes its spec after ${asynchronous ? "asynchronous" : "synchronous"} worker launch failure`, async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-worker-start-failed-"));
  const originalSpawn = childProcess.spawn;
  try {
    childProcess.spawn = () => {
      const error = new Error("fixture launch failed");
      if (!asynchronous) throw error;
      const child = new EventEmitter();
      process.nextTick(() => child.emit("error", error));
      return child;
    };
    syncBuiltinESMExports();
    await assert.rejects(startClaudeJob({ input: { permissionMode: "plan", timeoutSeconds: 1 } }, {
      dataRoot, sessionId, environment: {},
    }), /fixture launch failed/);
    const state = await loadSessionState(dataRoot, sessionId);
    assert.equal(state.activeJob.status, "failed");
    assert.match(state.activeJob.error, /fixture launch failed/);
    assert.deepEqual(await readdir(path.join(dataRoot, "jobs", sessionId)), []);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
}

test("a submitted decision is described as resuming instead of repeating the old request", () => {
  const text = approvalText({
    id: jobId,
    decision: { action: "allow" },
    pendingApproval: { id: approvalId, toolName: "Bash", inputText: "{}" },
  });
  assert.match(text, /已提交/);
  assert.match(text, /正在从暂停处恢复/);
  assert.doesNotMatch(text, /真实的权限请求/);
});

test("cancelling a waiting job waits for termination and never offers stale approvals", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-cancel-waiting-"));
  try {
    await saveSessionState(dataRoot, sessionId, { activeJob: {
      id: jobId, status: "waiting", cancelRequested: false, decision: null,
      pendingApproval: { id: approvalId, toolName: "Bash", inputText: "{}" },
    } });
    let settled = false;
    const response = cancelClaudeJob({ jobId }, { dataRoot, sessionId })
      .then((value) => { settled = true; return value; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await loadSessionState(dataRoot, sessionId)).activeJob.cancelRequested) break;
      await delay(10);
    }
    await delay(180);
    assert.equal(settled, false);
    const job = (await loadSessionState(dataRoot, sessionId)).activeJob;
    assert.equal(job.cancelRequested, true);
    assert.match(approvalText(job), /正在取消/);
    assert.doesNotMatch(approvalText(job), /claude allow|真实的权限请求/);
    assert.match(await describeClaudeJob({ dataRoot, sessionId }), /正在取消/);
    await assert.rejects(resolveClaudeApproval({ kind: "allow", approvalId }, { dataRoot, sessionId }), /没有找到/);
    await withStateLock(dataRoot, sessionLockName(sessionId), async () => {
      const state = await loadSessionState(dataRoot, sessionId);
      state.activeJob.status = "cancelled";
      state.activeJob.pendingApproval = null;
      state.activeJob.error = "cancelled fixture";
      await saveSessionState(dataRoot, sessionId, state);
    });
    assert.doesNotMatch(await response, /claude allow|原进程正在等待/);
    assert.equal((await loadSessionState(dataRoot, sessionId)).activeJob, null);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDecision(dataRoot) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const decision = (await loadSessionState(dataRoot, sessionId)).activeJob?.decision;
    if (decision) return decision;
    await delay(10);
  }
  throw new Error("approval decision was not stored");
}

for (const command of [
  { kind: "allow", approvalId, scope: "once" },
  { kind: "deny", approvalId, reason: "not allowed" },
  { kind: "answer", approvalId, answers: { question: "answer" } },
]) {
  test(`${command.kind} waits for the resumed job instead of repeating the stale approval`, async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-claude-code-bridge-manager-"));
    try {
      await saveSessionState(dataRoot, sessionId, {
        version: 1,
        authorization: null,
        images: [],
        lastClipboardSequence: null,
        activeJob: {
          id: jobId,
          status: "waiting",
          pendingApproval: {
            id: approvalId,
            toolName: command.kind === "answer" ? "AskUserQuestion" : "Bash",
            inputText: "{}",
          },
          decision: null,
          cancelRequested: false,
          resultPath: null,
          error: null,
        },
        sessionPermission: null,
        sessionEnded: false,
        claudeSessionId: null,
        claudeSessionRoot: null,
        forkNext: false,
        resultFiles: [],
      });

      let settled = false;
      const responsePromise = resolveClaudeApproval(command, {
        dataRoot,
        sessionId,
      }).then((value) => {
        settled = true;
        return value;
      });
      const decision = await waitForDecision(dataRoot);
      assert.equal(decision.action, command.kind);
      await delay(250);
      assert.equal(settled, false);

      const resultDirectory = path.join(dataRoot, "results", sessionId);
      const resultPath = path.join(resultDirectory, `${jobId}.md`);
      await mkdir(resultDirectory, { recursive: true });
      await writeFile(resultPath, `resumed after ${command.kind}`, "utf8");
      await withStateLock(dataRoot, sessionLockName(sessionId), async () => {
        const state = await loadSessionState(dataRoot, sessionId);
        state.activeJob.status = "completed";
        state.activeJob.pendingApproval = null;
        state.activeJob.decision = null;
        state.activeJob.resultPath = resultPath;
        await saveSessionState(dataRoot, sessionId, state);
      });

      assert.equal(await responsePromise, `resumed after ${command.kind}`);
      assert.equal((await loadSessionState(dataRoot, sessionId)).activeJob, null);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
}

for (const mismatch of [
  {
    name: "answer for a non-question tool",
    toolName: "Bash",
    command: { kind: "answer", approvalId, answers: { question: "answer" } },
    message: /只能处理 AskUserQuestion/,
  },
  {
    name: "allow for AskUserQuestion",
    toolName: "AskUserQuestion",
    command: { kind: "allow", approvalId, scope: "once" },
    message: /需要使用 claude answer/,
  },
]) {
  test(`rejects ${mismatch.name}`, async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-claude-code-bridge-manager-"));
    try {
      await saveSessionState(dataRoot, sessionId, {
        version: 1,
        authorization: null,
        images: [],
        lastClipboardSequence: null,
        activeJob: {
          id: jobId,
          status: "waiting",
          pendingApproval: {
            id: approvalId,
            toolName: mismatch.toolName,
            inputText: "{}",
          },
          decision: null,
          cancelRequested: false,
          resultPath: null,
          error: null,
        },
        sessionPermission: null,
        sessionEnded: false,
        claudeSessionId: null,
        claudeSessionRoot: null,
        forkNext: false,
        resultFiles: [],
      });

      await assert.rejects(
        resolveClaudeApproval(mismatch.command, { dataRoot, sessionId }),
        mismatch.message,
      );
      assert.equal((await loadSessionState(dataRoot, sessionId)).activeJob.decision, null);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
}
