import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cancelClaudeJob,
  interruptClaudeJob,
  startClaudeJob,
  synchronousWaitMilliseconds,
} from "../server/lib/claude-job-manager.mjs";
import { handleHookEvent } from "../server/lib/command-handler.mjs";
import { loadSessionState } from "../server/lib/state-store.mjs";
import { normalizeRunInput } from "../server/lib/validation.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const mockClaude = path.join(testDirectory, "fixtures", "mock-claude.mjs");

function mockEnvironment() {
  return {
    ...process.env,
    CLAUDE_CODE_BRIDGE_COMMAND: process.execPath,
    CLAUDE_CODE_BRIDGE_COMMAND_ARGS: JSON.stringify([mockClaude]),
  };
}

async function requestFor(workingDirectory, prompt, timeoutSeconds) {
  const input = await normalizeRunInput({
    prompt,
    working_directory: workingDirectory,
    permission_mode: "plan",
    timeout_seconds: timeoutSeconds,
    customization_sources: "plugin-only",
    persist_session: false,
  });
  return {
    prompt,
    input,
    imageIds: [],
    authorizationRoot: workingDirectory,
    conversation: { messageCount: 0, truncated: false },
  };
}

async function waitForRunning(dataRoot, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = (await loadSessionState(dataRoot, sessionId)).activeJob;
    if (job?.status === "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("mock Claude job did not enter running state");
}

test("derives the synchronous hook wait from the Claude timeout instead of a fixed 30 seconds", () => {
  assert.equal(synchronousWaitMilliseconds(1), 31_000);
  assert.equal(synchronousWaitMilliseconds(1_800), 1_830_000);
  assert.equal(synchronousWaitMilliseconds(3_600), 3_630_000);
});

test("waits for a delayed worker and returns its final text in the original command", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-sync-job-"));
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  try {
    const startedAt = Date.now();
    const text = await startClaudeJob(
      await requestFor(dataRoot, "__DELAY_150__", 2),
      { dataRoot, sessionId, environment: mockEnvironment() },
    );
    assert.ok(Date.now() - startedAt >= 100);
    assert.match(text, /mock:__DELAY_150__/);
    assert.doesNotMatch(text, /正在运行/);
    assert.equal((await loadSessionState(dataRoot, sessionId)).activeJob, null);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runs independent Claude jobs concurrently in different Codex sessions", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-concurrent-jobs-"));
  const firstSession = "11111111-2222-4333-8444-555555555555";
  const secondSession = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  try {
    const [first, second] = await Promise.all([
      startClaudeJob(
        await requestFor(dataRoot, "__DELAY_200__", 2),
        { dataRoot, sessionId: firstSession, environment: mockEnvironment() },
      ),
      startClaudeJob(
        await requestFor(dataRoot, "__DELAY_250__", 2),
        { dataRoot, sessionId: secondSession, environment: mockEnvironment() },
      ),
    ]);
    assert.match(first, /mock:__DELAY_200__/);
    assert.match(second, /mock:__DELAY_250__/);
    assert.equal((await loadSessionState(dataRoot, firstSession)).activeJob, null);
    assert.equal((await loadSessionState(dataRoot, secondSession)).activeJob, null);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("returns a terminal timeout instead of a running placeholder", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-timeout-job-"));
  const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  try {
    const text = await startClaudeJob(
      await requestFor(dataRoot, "__HANG__", 1),
      { dataRoot, sessionId, environment: mockEnvironment() },
    );
    assert.match(text, /任务失败/);
    assert.match(text, /1-second timeout/);
    assert.doesNotMatch(text, /正在运行/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("an interrupt cancels the detached worker while the original command is waiting", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-interrupt-job-"));
  const sessionId = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";
  try {
    const pending = startClaudeJob(
      await requestFor(dataRoot, "__HANG__", 10),
      { dataRoot, sessionId, environment: mockEnvironment() },
    );
    await waitForRunning(dataRoot, sessionId);
    await interruptClaudeJob({ dataRoot, sessionId });
    const text = await pending;
    assert.match(text, /任务已取消/);
    assert.equal((await loadSessionState(dataRoot, sessionId)).activeJob, null);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("an explicit cancel command terminates the requested active job", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-cancel-job-"));
  const sessionId = "eeeeeeee-ffff-4000-8aaa-cccccccccccc";
  const context = { dataRoot, sessionId, environment: mockEnvironment() };
  try {
    const pending = startClaudeJob(await requestFor(dataRoot, "__HANG__", 10), context);
    const job = await waitForRunning(dataRoot, sessionId);
    const cancellation = cancelClaudeJob({ kind: "cancel", jobId: job.id }, context);
    const responses = await Promise.all([pending, cancellation]);
    assert.match(responses.join("\n"), /任务已取消/);
    assert.equal((await loadSessionState(dataRoot, sessionId)).activeJob, null);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("SessionEnd cancels an active worker and removes its session state", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-session-end-job-"));
  const sessionId = "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb";
  const environment = { ...mockEnvironment(), PLUGIN_DATA: dataRoot };
  try {
    const pending = startClaudeJob(
      await requestFor(dataRoot, "__HANG__", 10),
      { dataRoot, sessionId, environment },
    );
    await waitForRunning(dataRoot, sessionId);
    assert.equal(await handleHookEvent({
      hook_event_name: "SessionEnd",
      session_id: sessionId,
      cwd: dataRoot,
    }, { environment }), null);
    await pending;
    await assert.rejects(access(path.join(dataRoot, "state", "sessions", `${sessionId}.json`)));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
