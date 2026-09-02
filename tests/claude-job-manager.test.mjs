import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { approvalText, resolveClaudeApproval } from "../server/lib/claude-job-manager.mjs";
import {
  loadSessionState,
  saveSessionState,
  sessionLockName,
  withStateLock,
} from "../server/lib/state-store.mjs";

const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const jobId = "a1b2c3d4";
const approvalId = "f0e1d2c3";

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
