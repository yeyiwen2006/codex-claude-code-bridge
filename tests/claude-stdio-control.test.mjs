import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachClaudeStdioControl } from "../server/lib/claude-stdio-control.mjs";
import { runClaudeNative, buildNativeClaudeArguments } from "../server/lib/claude-runner.mjs";
import { normalizeRunInput } from "../server/lib/validation.mjs";
import { startClaudeJob, resolveClaudeApproval, cancelClaudeJob } from "../server/lib/claude-job-manager.mjs";
import { loadSessionState } from "../server/lib/state-store.mjs";

const mock = fileURLToPath(new URL("./fixtures/mock-claude-control.mjs", import.meta.url));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function channel(onPermission) {
  const child = { stdin: new PassThrough(), stdout: new PassThrough() };
  const sent = [];
  const errors = [];
  child.stdin.on("data", (chunk) => sent.push(JSON.parse(chunk.toString("utf8"))));
  const cleanup = attachClaudeStdioControl(child, "中文 Don't parse me", onPermission, (error) => errors.push(error));
  const receive = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  return { child, sent, errors, cleanup, receive };
}

test("stdio sends the prompt once after initialization and closes only at the final result", async (t) => {
  const c = channel(async () => ({ behavior: "deny", message: "unused" }));
  t.after(c.cleanup);
  assert.equal(c.sent.length, 1);
  const ack = { type: "control_response", response: { subtype: "success", request_id: c.sent[0].request_id } };
  c.receive(ack);
  c.receive(ack);
  assert.equal(c.sent.length, 2);
  assert.equal(c.sent[1].message.content, "中文 Don't parse me");
  c.receive({ type: "system", subtype: "task_started", task_id: "background", task_type: "local_agent" });
  c.receive({ type: "result" });
  assert.equal(c.child.stdin.writableEnded, false);
  c.receive({ type: "system", subtype: "task_notification", task_id: "background", status: "completed" });
  c.receive({ type: "result" });
  assert.equal(c.child.stdin.writableEnded, true);
});

test("stdio serializes tool requests, honours cancellation and rejects unknown controls", async (t) => {
  const started = [];
  let finishFirst;
  const c = channel(async (request, { signal }) => {
    started.push(request.tool_name);
    if (request.tool_name === "first") await new Promise((resolve) => {
      finishFirst = resolve;
      signal.addEventListener("abort", resolve, { once: true });
    });
    return { behavior: "deny", message: "test denial" };
  });
  t.after(c.cleanup);
  c.receive({ type: "control_request", request_id: "one", request: { subtype: "can_use_tool", tool_name: "first" } });
  c.receive({ type: "control_request", request_id: "two", request: { subtype: "can_use_tool", tool_name: "second" } });
  await tick();
  assert.deepEqual(started, ["first"]);
  c.receive({ type: "control_cancel_request", request_id: "one" });
  finishFirst();
  await tick();
  assert.deepEqual(started, ["first", "second"]);
  assert.equal(c.sent.some((message) => message.response?.request_id === "one"), false);
  assert.equal(c.sent.at(-1).response.response.behavior, "deny");
  c.receive({ type: "control_request", request_id: "unknown", request: { subtype: "unknown" } });
  await tick();
  assert.equal(c.sent.at(-1).response.subtype, "error");
});

test("stdio reports initialization failure without submitting a model request", (t) => {
  const c = channel(async () => assert.fail("must not ask permission"));
  t.after(c.cleanup);
  c.receive({ type: "control_response", response: { subtype: "error", request_id: c.sent[0].request_id, error: "fixture failure" } });
  assert.match(c.errors[0].message, /fixture failure/);
  assert.equal(c.sent.length, 1);
});

for (const [action, prompt, toolName] of [
  ["allow", "write", "Write"], ["deny", "write", "Write"], ["answer", "__QUESTION__", "AskUserQuestion"],
]) {
  test(`safe worker pauses and resumes the same process after ${action}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-stdio-worker-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sessionId = "safe-worker-session";
    const context = { dataRoot: root, sessionId, environment: {
      ...process.env, CLAUDE_CODE_BRIDGE_COMMAND: process.execPath,
      CLAUDE_CODE_BRIDGE_COMMAND_ARGS: JSON.stringify([mock]),
    } };
    const input = await normalizeRunInput({ prompt, working_directory: root, permission_mode: "default",
      customization_sources: "safe", timeout_seconds: 5 });
    const first = await startClaudeJob({ prompt, taskPrompt: prompt, input, authorizationRoot: root, imageIds: [] }, context);
    assert.match(first, new RegExp(`工具：${toolName}`));
    const job = (await loadSessionState(root, sessionId)).activeJob;
    assert.ok(job.workerPid);
    const result = await resolveClaudeApproval({ kind: action, approvalId: job.pendingApproval.id,
      scope: "session", reason: "拒绝写入", answers: { "选择？": "甲" } }, context);
    const response = JSON.parse(result.split("\n\n[Codex Claude Code Bridge")[0]);
    assert.equal(response.response.behavior, action === "deny" ? "deny" : "allow");
    if (action === "allow") assert.equal(response.response.updatedPermissions[0].destination, "session");
    if (action === "answer") assert.deepEqual(response.response.updatedInput.answers, { "选择？": "甲" });
    if (action === "deny") assert.equal(response.response.message, "拒绝写入");
    assert.equal((await loadSessionState(root, sessionId)).activeJob, null);
  });
}

test("safe stdio invocation keeps isolation flags and still honours process timeouts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-stdio-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await normalizeRunInput({ prompt: "__HANG__", working_directory: root,
    customization_sources: "safe", timeout_seconds: 1 });
  const options = { commandConfiguration: { command: process.execPath, prefixArguments: [mock] },
    onPermission: async () => assert.fail("no permission expected") };
  const args = buildNativeClaudeArguments(input, options);
  assert.ok(args.includes("--safe-mode"));
  assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], "stdio");
  assert.equal(args.includes("--mcp-config"), false);
  await assert.rejects(runClaudeNative(input, options), (error) => error.code === "TIMEOUT");
});

test("safe worker can be cancelled while awaiting a tool decision", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-stdio-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { dataRoot: root, sessionId: "safe-cancel-session", environment: {
    ...process.env, CLAUDE_CODE_BRIDGE_COMMAND: process.execPath,
    CLAUDE_CODE_BRIDGE_COMMAND_ARGS: JSON.stringify([mock]),
  } };
  const input = await normalizeRunInput({ prompt: "write", working_directory: root,
    customization_sources: "safe", timeout_seconds: 5 });
  await startClaudeJob({ prompt: "write", input, authorizationRoot: root, imageIds: [] }, context);
  const result = await cancelClaudeJob({ kind: "cancel" }, context);
  assert.match(result, /取消/);
  assert.doesNotMatch(result, /claude allow/);
});
