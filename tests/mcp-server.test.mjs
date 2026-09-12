import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { handleMessage, TOOLS } from "../server/index.mjs";
import { BRIDGE_VERSION } from "../server/lib/version.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..");
const serverPath = path.join(repositoryRoot, "server", "index.mjs");
const mockClaude = path.join(testDirectory, "fixtures", "mock-claude.mjs");
let temporaryDirectory;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-claude-code-bridge-mcp-"));
});

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("publishes health, directory authorization, plan, and modification tools", () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), [
    "claude_code_health",
    "claude_code_authorize_directory",
    "claude_code_plan",
    "claude_code_run",
  ]);
  const modificationTool = TOOLS.find((tool) => tool.name === "claude_code_run");
  assert.equal(modificationTool.annotations.destructiveHint, true);
  assert.deepEqual(
    modificationTool.inputSchema.properties.permission_mode.enum,
    ["acceptEdits", "auto", "dontAsk"],
  );
  assert.equal("allowed_tools" in modificationTool.inputSchema.properties, false);
});

test("rejects malformed JSON-RPC envelopes before dispatch", async () => {
  for (const message of [
    {}, { jsonrpc: "1.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 1, method: 42 },
    { jsonrpc: "2.0", id: null, method: "ping" },
    { jsonrpc: "2.0", id: {}, method: "ping" },
  ]) {
    const response = await handleMessage(message);
    assert.equal(response.error?.code, -32600);
  }
  const response = await handleMessage({ jsonrpc: "2.0", id: "bad-params", method: "ping", params: [] });
  assert.equal(response.error?.code, -32602);
});

test("never dispatches request methods sent as notifications or replies to them", async () => {
  for (const method of ["ping", "tools/list", "unknown", "tools/call"]) {
    const response = await handleMessage({ jsonrpc: "2.0", method,
      params: { name: "claude_code_authorize_directory", arguments: { directory: temporaryDirectory } } });
    assert.equal(response, undefined);
  }
});

test("rejects duplicate active request ids without replacing the original request", async () => {
  const request = { jsonrpc: "2.0", id: "active-authorization", method: "tools/call", params: {
    name: "claude_code_authorize_directory", arguments: { directory: temporaryDirectory },
  } };
  const first = handleMessage(request);
  const duplicate = await handleMessage({ jsonrpc: "2.0", id: request.id, method: "ping" });
  assert.equal(duplicate.error?.code, -32600);
  assert.equal((await first).result.structuredContent.ok, true);
});

test("rejects non-object tool arguments before dispatch", async () => {
  for (const argumentsValue of [null, [], "bad", 1]) {
    const response = await handleMessage({ jsonrpc: "2.0", id: "bad-tool-args", method: "tools/call", params: {
      name: "claude_code_authorize_directory", arguments: argumentsValue,
    } });
    assert.equal(response.error?.code, -32602);
  }
});

test("returns a protocol error for an unknown tool", async () => {
  const response = await handleMessage({ jsonrpc: "2.0", id: "unknown-tool", method: "tools/call",
    params: { name: "no_such_tool", arguments: {} } });
  assert.equal(response.error?.code, -32602);
  assert.match(response.error.message, /Unknown tool/);
});

test("enforces authorization, plan restrictions, sessions, and cancellation locks", { timeout: 15_000 }, async (context) => {
  const previousCommand = process.env.CLAUDE_CODE_BRIDGE_COMMAND;
  const previousArgs = process.env.CLAUDE_CODE_BRIDGE_COMMAND_ARGS;
  process.env.CLAUDE_CODE_BRIDGE_COMMAND = process.execPath;
  process.env.CLAUDE_CODE_BRIDGE_COMMAND_ARGS = JSON.stringify([mockClaude]);
  context.after(() => {
    if (previousCommand === undefined) delete process.env.CLAUDE_CODE_BRIDGE_COMMAND;
    else process.env.CLAUDE_CODE_BRIDGE_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.CLAUDE_CODE_BRIDGE_COMMAND_ARGS;
    else process.env.CLAUDE_CODE_BRIDGE_COMMAND_ARGS = previousArgs;
  });
  const alpha = path.join(temporaryDirectory, "alpha");
  const beta = path.join(temporaryDirectory, "beta");
  const gamma = path.join(temporaryDirectory, "gamma");
  await mkdir(alpha);
  await mkdir(beta);
  await mkdir(gamma);
  const attachedImage = path.join(beta, "fixture.png");
  await writeFile(attachedImage, Buffer.from("89504e470d0a1a0a", "hex"));
  let sequence = 0;
  const call = async (name, argumentsValue, id = `integration-${++sequence}`) =>
    (await handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: argumentsValue } })).result;
  const authorization = await call("claude_code_authorize_directory", { directory: temporaryDirectory });
  const base = { prompt: "__ARGS__", working_directory: alpha,
    authorization_id: authorization.structuredContent.authorization_id };
  const outside = await call("claude_code_run", { ...base, working_directory: os.tmpdir() });
  assert.match(outside.structuredContent.error, /outside the authorized root/);
  const plan = await call("claude_code_plan", { ...base, customization_sources: "all",
    persist_session: true, allow_plugin_tools: true });
  const args = JSON.parse(plan.structuredContent.result);
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  const persisted = await call("claude_code_run", { ...base, prompt: "persist", persist_session: true });
  const sessionId = persisted.structuredContent.session_id;
  const betaAuthorization = await call("claude_code_authorize_directory", { directory: beta });
  const moved = await call("claude_code_run", { ...base, working_directory: beta, session_id: sessionId,
    authorization_id: betaAuthorization.structuredContent.authorization_id });
  assert.match(moved.structuredContent.error, /different authorized project root/);

  const pending = [];
  context.after(async () => {
    for (const { id } of pending) await handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
    await Promise.allSettled(pending.map(({ promise }) => promise));
  });
  async function startHanging(id, workingDirectory, overrides = {}) {
    const marker = path.join(workingDirectory, `ready-${id}.txt`);
    const promise = call("claude_code_run", { ...base, working_directory: workingDirectory,
      prompt: `__HANG_READY__\n${marker}`, timeout_seconds: 8, ...overrides }, id);
    pending.push({ id, promise });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try { if (await readFile(marker, "utf8") === "ready") return { promise }; } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(15);
    }
    assert.fail("Mock Claude did not signal startup.");
  }
  await startHanging("lock-alpha", alpha, { session_id: sessionId, image_paths: [attachedImage] });
  const overlapping = await call("claude_code_run", { ...base, prompt: "blocked" });
  assert.match(overlapping.structuredContent.error, /overlapping directory/);
  const imageOverlap = await call("claude_code_run", { ...base, working_directory: beta });
  assert.match(imageOverlap.structuredContent.error, /overlapping directory/);
  const sameSession = await call("claude_code_run", { ...base, working_directory: gamma, session_id: sessionId });
  assert.match(sameSession.structuredContent.error, /session is already active/);
  await startHanging("lock-gamma", gamma);
  const busy = await call("claude_code_plan", base);
  assert.match(busy.structuredContent.error, /maximum number/);
  for (const { id, promise } of pending) {
    await handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
    assert.equal((await promise).structuredContent.error_code, "CANCELLED");
  }
  const resumed = await call("claude_code_run", { ...base, session_id: sessionId, prompt: "after-cancel" });
  assert.equal(resumed.structuredContent.result, "mock:after-cancel");
});

test("serves JSON-RPC over stdio and invokes the configured CLI", async (context) => {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CLAUDE_CODE_BRIDGE_COMMAND: process.execPath,
      CLAUDE_CODE_BRIDGE_COMMAND_ARGS: JSON.stringify([mockClaude]),
    },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null) {
      child.kill();
    }
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();

  async function request(payload) {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    const next = await iterator.next();
    assert.equal(next.done, false, `server exited early: ${stderr}`);
    return JSON.parse(next.value);
  }

  const initialized = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(initialized.result.serverInfo.name, "codex-claude-code-bridge");
  assert.equal(initialized.result.serverInfo.version, BRIDGE_VERSION);

  const health = await request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "claude_code_health", arguments: {} },
  });
  assert.equal(health.result.structuredContent.authenticated, true);

  const authorization = await request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "claude_code_authorize_directory",
      arguments: { directory: temporaryDirectory },
    },
  });
  assert.equal(authorization.result.structuredContent.ok, true);

  for (const permissionMode of ["bypassPermissions", "manual", "default", "plan"]) {
    const rejected = await request({
      jsonrpc: "2.0", id: `unsupported-${permissionMode}`, method: "tools/call",
      params: { name: "claude_code_run", arguments: {
        prompt: "must-not-run", working_directory: temporaryDirectory,
        authorization_id: authorization.result.structuredContent.authorization_id,
        permission_mode: permissionMode,
      } },
    });
    assert.equal(rejected.result.isError, true, `MCP must reject ${permissionMode}`);
    assert.equal(rejected.result.structuredContent.error_code, "INVALID_ARGUMENT");
  }

  const run = await request({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "claude_code_run",
      arguments: {
        prompt: "wire-test",
        working_directory: temporaryDirectory,
        authorization_id: authorization.result.structuredContent.authorization_id,
        persist_session: false,
      },
    },
  });
  assert.equal(run.result.structuredContent.result, "mock:wire-test");
  assert.equal(run.result.structuredContent.ok, true);

  child.stdin.end();
});
