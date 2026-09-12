import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { requestPermission } from "../server/lib/permission-prompt-server.mjs";
import { BRIDGE_VERSION } from "../server/lib/version.mjs";
import {
  loadSessionState,
  saveSessionState,
  sessionLockName,
  withStateLock,
} from "../server/lib/state-store.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDirectory, "../server/lib/permission-prompt-server.mjs");
const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const jobId = "a1b2c3d4";
let dataRoot;

before(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-claude-code-bridge-permission-"));
  await saveSessionState(dataRoot, sessionId, {
    version: 1,
    authorization: null,
    images: [],
    lastClipboardSequence: null,
    activeJob: {
      id: jobId,
      status: "running",
      pendingApproval: null,
      decision: null,
      cancelRequested: false,
    },
    sessionPermission: null,
    claudeSessionId: null,
    claudeSessionRoot: null,
    forkNext: false,
    resultFiles: [],
  });
});

after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("parks one actual tool request and resumes it after an allow decision", async (context) => {
  const child = spawn(process.execPath, [serverPath, dataRoot, sessionId, jobId], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const initialized = JSON.parse((await iterator.next()).value);
  assert.equal(initialized.result.serverInfo.name, "codex-claude-code-bridge-permission");
  assert.equal(initialized.result.serverInfo.version, BRIDGE_VERSION);

  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "request",
      arguments: {
        tool_name: "Bash",
        input: { command: "npm test" },
        tool_use_id: "tool-1",
        permission_suggestions: [{
          type: "addRules",
          behavior: "allow",
          destination: "session",
          rules: [{ toolName: "Bash", ruleContent: "npm test" }],
        }],
      },
    },
  });

  let approvalId;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await loadSessionState(dataRoot, sessionId);
    approvalId = state.activeJob?.pendingApproval?.id;
    if (approvalId) break;
    await delay(20);
  }
  assert.match(approvalId, /^[0-9a-f]{8}$/);
  await withStateLock(dataRoot, sessionLockName(sessionId), async () => {
    const state = await loadSessionState(dataRoot, sessionId);
    state.activeJob.decision = {
      approvalId,
      action: "allow",
      scope: "session",
      createdAt: Date.now(),
    };
    await saveSessionState(dataRoot, sessionId, state);
  });

  const reply = JSON.parse((await iterator.next()).value);
  const decision = JSON.parse(reply.result.content[0].text);
  assert.equal(decision.behavior, "allow");
  assert.deepEqual(decision.updatedInput, { command: "npm test" });
  assert.equal(decision.updatedPermissions[0].destination, "session");
  const finalState = await loadSessionState(dataRoot, sessionId);
  assert.equal(finalState.activeJob.status, "running");
  assert.equal(finalState.activeJob.pendingApproval, null);
  child.stdin.end();
});

test("parks AskUserQuestion and resumes it with the submitted answers", async (context) => {
  const child = spawn(process.execPath, [serverPath, dataRoot, sessionId, jobId], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await iterator.next();
  const questions = [{ question: "Which database?", options: ["SQLite", "Postgres"] }];
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "request",
      arguments: {
        tool_name: "AskUserQuestion",
        input: { questions },
        tool_use_id: "tool-question-1",
      },
    },
  });

  let approvalId;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await loadSessionState(dataRoot, sessionId);
    approvalId = state.activeJob?.pendingApproval?.id;
    if (approvalId) break;
    await delay(20);
  }
  assert.match(approvalId, /^[0-9a-f]{8}$/);
  await withStateLock(dataRoot, sessionLockName(sessionId), async () => {
    const state = await loadSessionState(dataRoot, sessionId);
    state.activeJob.decision = {
      approvalId,
      action: "answer",
      answers: { "Which database?": "SQLite" },
      createdAt: Date.now(),
    };
    await saveSessionState(dataRoot, sessionId, state);
  });

  const reply = JSON.parse((await iterator.next()).value);
  const decision = JSON.parse(reply.result.content[0].text);
  assert.equal(decision.behavior, "allow");
  assert.deepEqual(decision.updatedInput, {
    questions,
    answers: { "Which database?": "SQLite" },
  });
  child.stdin.end();
});

test("answers ping and cancels an MCP approval without blocking the next request", async (context) => {
  const child = spawn(process.execPath, [serverPath, dataRoot, sessionId, jobId], {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  context.after(async () => {
    if (child.exitCode === null) child.kill();
    await closed;
  });
  const replies = [];
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => replies.push(JSON.parse(line)));
  const send = (payload) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
  const request = (id, toolName) => send({ id, method: "tools/call", params: {
    name: "request", arguments: { tool_name: toolName, input: { fixture: true } },
  } });
  const waitFor = async (check, description) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await check();
      if (value) return value;
      await delay(20);
    }
    assert.fail(description);
  };
  request(10, "First");
  await waitFor(async () => (await loadSessionState(dataRoot, sessionId)).activeJob.pendingApproval?.toolName === "First", "first approval was not parked");
  send({ jsonrpc: "1.0", id: "bad-version", method: "ping" });
  assert.equal((await waitFor(() => replies.find((reply) => reply.id === "bad-version"), "invalid version was not rejected")).error.code, -32600);
  send({ id: "bad-params", method: "ping", params: [] });
  assert.equal((await waitFor(() => replies.find((reply) => reply.id === "bad-params"), "invalid params were not rejected")).error.code, -32602);
  send({ id: "invalid-cancel", method: "notifications/cancelled", params: { requestId: 10 } });
  assert.equal((await waitFor(() => replies.find((reply) => reply.id === "invalid-cancel"), "request-form cancellation was not rejected")).error.code, -32601);
  assert.equal((await loadSessionState(dataRoot, sessionId)).activeJob.pendingApproval?.toolName, "First");
  send({ id: 11, method: "ping" });
  assert.deepEqual((await waitFor(() => replies.find((reply) => reply.id === 11), "ping was blocked by a pending approval")).result, {});
  request(12, "Second");
  send({ method: "notifications/cancelled", params: { requestId: 10 } });
  const next = await waitFor(async () => {
    const pending = (await loadSessionState(dataRoot, sessionId)).activeJob.pendingApproval;
    return pending?.toolName === "Second" ? pending : null;
  }, "the cancelled approval blocked the next request");
  await withStateLock(dataRoot, sessionLockName(sessionId), async () => {
    const state = await loadSessionState(dataRoot, sessionId);
    state.activeJob.decision = { approvalId: next.id, action: "deny", reason: "fixture denied" };
    await saveSessionState(dataRoot, sessionId, state);
  });
  const reply = await waitFor(() => replies.find((entry) => entry.id === 12), "second approval did not resolve");
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { behavior: "deny", message: "fixture denied" });
  assert.equal(replies.some((entry) => entry.id === 10), false, "cancelled MCP requests must not send late responses");
  assert.equal((await loadSessionState(dataRoot, sessionId)).activeJob.pendingApproval, null);
  child.stdin.end();
});

test("does not revive a terminal job for a late permission request", async () => {
  await withStateLock(dataRoot, sessionLockName(sessionId), async () => {
    const state = await loadSessionState(dataRoot, sessionId);
    state.activeJob.status = "completed";
    await saveSessionState(dataRoot, sessionId, state);
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    await assert.rejects(requestPermission({ tool_name: "Write", input: {} }, {
      dataRoot, sessionId, jobId,
    }, { signal: controller.signal }), /no longer running/i);
    assert.equal((await loadSessionState(dataRoot, sessionId)).activeJob.status, "completed");
  } finally {
    clearTimeout(timer);
  }
});
