import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleHookEvent } from "../server/lib/command-handler.mjs";
import { DEFAULT_COMMAND_CONFIG, loadCommandConfig, saveCommandConfig } from "../server/lib/state-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-config-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const submit = (prompt, overrides = {}) => handleHookEvent({
    hook_event_name: "UserPromptSubmit", session_id: "config-test-session", cwd: root, prompt,
  }, { environment: { ...process.env, PLUGIN_DATA: data }, ...overrides });
  return { root, data, submit };
}

test("help and reset recover an invalid configuration without losing valid fields", async (t) => {
  const { data, submit } = await fixture(t);
  await saveCommandConfig(data, { ...DEFAULT_COMMAND_CONFIG, effort: "invalid", model: "sonnet" });
  assert.match((await submit("claude help")).reason, /基础/);
  assert.match((await submit("claude config reset effort")).reason, /设置已重置/);
  assert.equal((await loadCommandConfig(data)).model, "sonnet");
  await saveCommandConfig(data, { ...DEFAULT_COMMAND_CONFIG, timeoutSeconds: -1, model: "sonnet" });
  assert.match((await submit("/claude config set timeout-seconds 30")).reason, /设置已更新/);
  assert.equal((await loadCommandConfig(data)).timeoutSeconds, 30);
});

test("reset all recovers even malformed JSON and help remains available", async (t) => {
  const { data, submit } = await fixture(t);
  await saveCommandConfig(data, DEFAULT_COMMAND_CONFIG);
  const configPath = path.join(data, "state", "config.json");
  await writeFile(configPath, '{"broken":', "utf8");
  assert.match((await submit("claude help")).reason, /基础/);
  assert.match((await submit("claude config reset all")).reason, /设置已重置/);
  assert.deepEqual(await loadCommandConfig(data), DEFAULT_COMMAND_CONFIG);
});

test("config accepts extended-context model names and rejects non-string stored models", async (t) => {
  const { data, submit } = await fixture(t);
  for (const model of ["opus[1m]", "sonnet[1m]"]) {
    assert.match((await submit(`claude config set model ${model}`)).reason, /设置已更新/);
    assert.equal((await loadCommandConfig(data)).model, model);
  }
  await saveCommandConfig(data, { ...DEFAULT_COMMAND_CONFIG, model: 42 });
  assert.match((await submit("claude config show")).reason, /model 无效/);
});

test("rejects a twenty-first plugin without corrupting the saved configuration", async (t) => {
  const { root, data, submit } = await fixture(t);
  const directories = Array.from({ length: 21 }, (_, i) => path.join(root, `plugin-${i}`));
  for (const directory of directories) {
    await mkdir(path.join(directory, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(directory, ".claude-plugin", "plugin.json"), '{"name":"fixture"}', "utf8");
  }
  await saveCommandConfig(data, { ...DEFAULT_COMMAND_CONFIG, pluginDirectories: directories.slice(0, 20) });
  const before = await readFile(path.join(data, "state", "config.json"), "utf8");
  assert.match((await submit(`claude plugin add "${directories[20]}"`)).reason, /失败/);
  assert.equal(await readFile(path.join(data, "state", "config.json"), "utf8"), before);
  assert.match((await submit("claude config show")).reason, /plugin-directories: 20/);
});

test("round-trips every public configuration setting through App and CLI commands", async (t) => {
  const { submit } = await fixture(t);
  for (const [key, value] of [
    ["model", "sonnet"], ["effort", "high"], ["permission", "plan"],
    ["customizations", "safe"], ["timeout-seconds", "60"], ["max-budget-usd", "0.5"],
    ["persist-session", "on"], ["conversation-context", "off"],
  ]) {
    assert.match((await submit(`claude config set ${key} ${value}`)).reason, /设置已更新/);
    assert.ok((await submit("/claude config show")).reason.includes(`${key}: ${value}`));
    assert.match((await submit(`/claude config reset ${key}`)).reason, /设置已重置/);
  }
  for (const invalid of ["effort impossible", "permission unknown", "timeout-seconds 0", "max-budget-usd -1", "persist-session yes"]) {
    assert.match((await submit(`claude config set ${invalid}`)).reason, /失败/);
  }
  assert.match((await submit("claude config show")).reason, /timeout-seconds: 1800/);
});

test("job cancellation, results and approvals remain usable with broken configuration", async (t) => {
  const { data, submit } = await fixture(t);
  await saveCommandConfig(data, { ...DEFAULT_COMMAND_CONFIG, effort: "broken" });
  const commands = [];
  const overrides = {
    cancelClaudeJob: async (command) => { commands.push(command.kind); return "cancelled"; },
    readClaudeJobResult: async () => { commands.push("result"); return "completed"; },
    resolveClaudeApproval: async (command) => { commands.push(command.kind); return "resolved"; },
  };
  for (const command of ["cancel", "result", "allow a1b2c3d4", "deny a1b2c3d4 -- stop", 'answer a1b2c3d4 -- {"Q":"A"}']) {
    assert.doesNotMatch((await submit(`claude ${command}`, overrides)).reason, /失败/);
  }
  assert.deepEqual(commands, ["cancel", "result", "allow", "deny", "answer"]);
});
