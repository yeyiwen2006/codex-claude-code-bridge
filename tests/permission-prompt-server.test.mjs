import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
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
  assert.equal(JSON.parse((await iterator.next()).value).result.serverInfo.name, "codex-claude-code-bridge-permission");

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
