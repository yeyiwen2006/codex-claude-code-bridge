import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../server/index.mjs";

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
