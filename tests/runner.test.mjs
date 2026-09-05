import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BridgeProcessError,
  buildClaudeArguments,
  buildNativeClaudeArguments,
  getClaudeHealth,
  runClaude,
  runClaudeNative,
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
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-claude-code-bridge-runner-"));
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

test("builds native bypass arguments without bridge tool or network denials", async () => {
  const input = await makeInput({
    permission_mode: "bypassPermissions",
    customization_sources: "all",
  });
  const argumentsList = buildNativeClaudeArguments(input, {
    permissionPromptToolName: "mcp__bridge__request",
    mcpConfig: { mcpServers: { bridge: { command: process.execPath, args: ["server.mjs"] } } },
  });

  assert.ok(argumentsList.includes("bypassPermissions"));
  assert.ok(argumentsList.includes("--allow-dangerously-skip-permissions"));
  assert.ok(argumentsList.includes("--permission-prompt-tool"));
  assert.equal(argumentsList[argumentsList.indexOf("--output-format") + 1], "stream-json");
  assert.ok(argumentsList.includes("--verbose"));
  assert.ok(argumentsList.includes("--include-hook-events"));
  assert.equal(argumentsList.includes("--tools"), false);
  assert.equal(argumentsList.includes("--allowed-tools"), false);
  assert.equal(argumentsList.includes("--disallowed-tools"), false);
  assert.equal(argumentsList.some((entry) => /Bash|PowerShell|WebFetch|WebSearch|mcp__\*/.test(entry)), false);
});

test("isolates native customization sources exactly as configured", async () => {
  const safe = buildNativeClaudeArguments(await makeInput({ customization_sources: "safe" }));
  const pluginOnly = buildNativeClaudeArguments(await makeInput({ customization_sources: "plugin-only" }));
  const all = buildNativeClaudeArguments(await makeInput({ customization_sources: "all" }));

  assert.ok(safe.includes("--safe-mode"));
  assert.equal(pluginOnly[pluginOnly.indexOf("--setting-sources") + 1], "");
  assert.equal(all.includes("--safe-mode"), false);
  assert.equal(all.includes("--setting-sources"), false);
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
  assert.equal(argumentsList[pluginIndex + 1], await realpath(temporaryDirectory));
  assert.ok(argumentsList.includes("Bash,PowerShell,WebFetch,WebSearch"));
  assert.equal(argumentsList.includes("Bash,PowerShell,WebFetch,WebSearch,mcp__*"), false);
});

test("keeps hook transcript files while fresh calls still omit session resumption", async () => {
  for (const customization of ["all", "user", "project"]) {
    const input = await makeInput({ customization_sources: customization, persist_session: false });
    const args = buildNativeClaudeArguments(input);
    assert.equal(args.includes("--no-session-persistence"), false);
    assert.equal(buildClaudeArguments(input).includes("--no-session-persistence"), false);
    assert.equal(args.includes("--resume"), false);
    assert.equal(args.includes("--continue"), false);
  }
  for (const customization of ["safe", "plugin-only"]) {
    const args = buildNativeClaudeArguments(await makeInput({ customization_sources: customization, persist_session: false }));
    assert.ok(args.includes("--no-session-persistence"));
  }
  const withPlugin = await normalizeRunInput({ prompt: "fixture", working_directory: temporaryDirectory,
    customization_sources: "plugin-only", persist_session: false, plugin_directories: [temporaryDirectory],
    allow_plugin_tools: true }, { allowPluginDirectories: true });
  assert.equal(buildNativeClaudeArguments(withPlugin).includes("--no-session-persistence"), false);
});

test("retains the original answer when failed Stop hooks produce a short repeated reply", async () => {
  const result = await runClaudeNative(await makeInput({ prompt: "__STOP_HOOK_LOOP__" }), { commandConfiguration });
  assert.equal(result.result_recovered_from_stream, true);
  assert.equal(result.recovery_includes_history, true);
  assert.match(result.result, /BRIDGE_APP_OK，中文正常/);
  assert.match(result.result, /同前/);
  assert.equal(result.hook_failures[0].transcript_missing, true);
});

test("normalizes successful Claude JSON output", async () => {
  const result = await runClaude(await makeInput(), { commandConfiguration });

  assert.equal(result.ok, true);
  assert.equal(result.result, "mock:hello");
  assert.equal(result.session_id, "11111111-2222-4333-8444-555555555555");
  assert.equal(result.total_cost_usd, 0);
  assert.deepEqual(result.permission_denials, []);
});

test("recovers an empty final envelope from the last main assistant stream message", async () => {
  const result = await runClaudeNative(await makeInput({
    prompt: "__EMPTY_WITH_ASSISTANT__",
    customization_sources: "plugin-only",
  }), { commandConfiguration });

  assert.equal(result.ok, true);
  assert.equal(result.result, "recovered assistant text");
  assert.equal(result.original_result_empty, true);
  assert.equal(result.result_recovered_from_stream, true);
  assert.equal(result.stream_assistant_messages, 1);
  assert.deepEqual(result.loaded_plugins, []);
});

test("keeps a genuinely empty stream empty and reports loaded customizations without retrying", async () => {
  const result = await runClaudeNative(await makeInput({
    prompt: "__EMPTY__",
    customization_sources: "all",
  }), { commandConfiguration });

  assert.equal(result.ok, true);
  assert.equal(result.result, "");
  assert.equal(result.original_result_empty, true);
  assert.equal(result.result_recovered_from_stream, false);
  assert.deepEqual(result.loaded_plugins, ["claude-mem@fixture"]);
  assert.equal(result.num_turns, 1);
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

test("enforces the child stderr byte limit", async () => {
  await assert.rejects(runClaude(await makeInput({ prompt: "__BIG_STDERR__" }), {
    commandConfiguration, maxOutputBytes: 64 * 1024,
  }), (error) => error instanceof BridgeProcessError && error.code === "OUTPUT_LIMIT");
});

test("terminates an invocation at its configured timeout", async () => {
  await assert.rejects(
    runClaude(await makeInput({ prompt: "__HANG__", timeout_seconds: 1 }), { commandConfiguration }),
    (error) => error instanceof BridgeProcessError && error.code === "TIMEOUT",
  );
});

test("health check returns only whitelisted authentication fields", async () => {
  const environment = { ...process.env };
  delete environment.ANTHROPIC_BASE_URL;
  const health = await getClaudeHealth({ commandConfiguration, environment });
  assert.deepEqual(health, {
    installed: true,
    version: "9.9.9 (Claude Code)",
    authenticated: true,
    auth_method: "test_token",
    api_provider: "test",
  });
});

test("health check reports a custom endpoint without exposing its URL", async () => {
  const health = await getClaudeHealth({
    commandConfiguration,
    environment: { ...process.env, ANTHROPIC_BASE_URL: "https://private.example.invalid/secret-path" },
  });
  assert.equal(health.custom_endpoint, true);
  assert.equal(JSON.stringify(health).includes("private.example.invalid"), false);
});
