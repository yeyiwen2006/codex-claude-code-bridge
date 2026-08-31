import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BridgeProcessError,
  buildClaudeArguments,
  getClaudeHealth,
  runClaude,
} from "../server/lib/claude-runner.mjs";
import { normalizeRunInput } from "../server/lib/validation.mjs";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const mockClaude = path.join(fixtureDirectory, "fixtures", "mock-claude.mjs");
const commandConfiguration = {
  command: process.execPath,
  prefixArguments: [mockClaude],
};
let temporaryDirectory;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "claude-code-bridge-runner-"));
});

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function makeInput(overrides = {}) {
  return normalizeRunInput({
    prompt: "hello",
    working_directory: temporaryDirectory,
    ...overrides,
  });
}

test("builds fixed argument arrays without prompt text or a permission bypass", async () => {
  const input = await makeInput({
    prompt: "--prompt-that-looks-like-an-option",
  });
  const argumentsList = buildClaudeArguments(input);

  assert.ok(argumentsList.includes("--safe-mode"));
  assert.equal(argumentsList.includes("--allowed-tools"), false);
  assert.equal(argumentsList.includes("--dangerously-skip-permissions"), false);
  assert.equal(argumentsList.includes("bypassPermissions"), false);
  assert.equal(argumentsList.includes("--prompt-that-looks-like-an-option"), false);
  assert.ok(argumentsList.includes("Read,Glob,Grep,Edit,Write"));
  assert.ok(argumentsList.includes("Bash,PowerShell,WebFetch,WebSearch,mcp__*"));
});

test("loads explicit plugins without user or project setting sources", async () => {
  const input = await normalizeRunInput({
    prompt: "use a plugin",
    working_directory: temporaryDirectory,
    customization_sources: "plugin-only",
    plugin_directories: [temporaryDirectory],
    allow_plugin_tools: true,
  }, { allowPluginDirectories: true });
  const argumentsList = buildClaudeArguments(input);
  const settingSourcesIndex = argumentsList.indexOf("--setting-sources");
  const pluginIndex = argumentsList.indexOf("--plugin-dir");

  assert.equal(argumentsList[settingSourcesIndex + 1], "");
  assert.equal(argumentsList[pluginIndex + 1], temporaryDirectory);
  assert.ok(argumentsList.includes("Bash,PowerShell,WebFetch,WebSearch"));
  assert.equal(argumentsList.includes("Bash,PowerShell,WebFetch,WebSearch,mcp__*"), false);
});

test("normalizes successful Claude JSON output", async () => {
  const result = await runClaude(await makeInput(), { commandConfiguration });

  assert.equal(result.ok, true);
  assert.equal(result.result, "mock:hello");
  assert.equal(result.session_id, "11111111-2222-4333-8444-555555555555");
  assert.equal(result.total_cost_usd, 0);
  assert.deepEqual(result.permission_denials, []);
});

test("passes a resume session without using continue", async () => {
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const result = await runClaude(await makeInput({ session_id: sessionId }), { commandConfiguration });
  assert.equal(result.session_id, sessionId);
});

test("returns a protocol warning for non-JSON stdout", async () => {
  const result = await runClaude(await makeInput({ prompt: "__MALFORMED__" }), { commandConfiguration });
  assert.equal(result.ok, false);
  assert.equal(result.result, "plain text fallback");
  assert.match(result.protocol_warning, /valid JSON/);
});

test("preserves a non-zero process result for the MCP layer", async () => {
  const result = await runClaude(await makeInput({ prompt: "__FAIL__" }), { commandConfiguration });
  assert.equal(result.ok, false);
  assert.equal(result.exit_code, 2);
  assert.match(result.stderr, /mock failure/);
});

test("treats a Claude result error subtype as failure even with exit zero", async () => {
  const result = await runClaude(await makeInput({ prompt: "__CLAUDE_ERROR__" }), { commandConfiguration });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["mock budget exhausted"]);
});

test("does not pass unrelated host secrets into Claude", async () => {
  const result = await runClaude(await makeInput({ prompt: "__ENV__" }), {
    commandConfiguration,
    environment: { ...process.env, GITHUB_TOKEN: "must-not-leak" },
  });
  assert.equal(result.result, "secret-absent");
});

test("enforces the child output byte limit", async () => {
  await assert.rejects(
    runClaude(await makeInput({ prompt: "__BIG__" }), {
      commandConfiguration,
      maxOutputBytes: 64 * 1024,
    }),
    (error) => error instanceof BridgeProcessError && error.code === "OUTPUT_LIMIT",
  );
});

test("terminates an invocation at its configured timeout", async () => {
  await assert.rejects(
    runClaude(await makeInput({ prompt: "__HANG__", timeout_seconds: 1 }), { commandConfiguration }),
    (error) => error instanceof BridgeProcessError && error.code === "TIMEOUT",
  );
});

test("health check returns only whitelisted authentication fields", async () => {
  const health = await getClaudeHealth({ commandConfiguration });
  assert.deepEqual(health, {
    installed: true,
    version: "9.9.9 (Claude Code)",
    authenticated: true,
    auth_method: "test_token",
    api_provider: "test",
  });
});
