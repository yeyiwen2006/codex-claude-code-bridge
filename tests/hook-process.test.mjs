import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeProcess } from "../server/lib/claude-runner.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const hook = path.join(root, "scripts", "command-hook.mjs");

test("actual hook process handles CLI, App attachments, malformed input and cleanup", async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "bridge-hook-wire-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const input = { hook_event_name: "UserPromptSubmit", session_id: "wire-hook-session", cwd: data };
  const run = (body) => executeProcess(process.execPath, [hook], {
    stdinText: typeof body === "string" ? body : JSON.stringify(body),
    environment: { ...process.env, PLUGIN_DATA: data }, inheritFullEnvironment: true, timeoutMs: 5000,
  });
  assert.match(JSON.parse((await run({ ...input, prompt: "claude help" })).stdout).reason, /Codex App 与 CLI 通用/);
  const wrapped = "# Files mentioned by the user:\n\n## 测试.png: C:/Temp/test.png\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\n/claude help";
  assert.match(JSON.parse((await run({ ...input, prompt: wrapped })).stdout).reason, /Codex App 与 CLI 通用/);
  assert.equal((await run({ ...input, prompt: "普通消息" })).stdout, "");
  assert.equal(JSON.parse((await run("{broken")).stdout).decision, "block");
  assert.equal((await run({ ...input, hook_event_name: "Interrupt" })).stdout, "");
  assert.equal((await run({ ...input, hook_event_name: "SessionEnd" })).stdout, "");
});

test("Windows manifest entry starts the hook through PLUGIN_ROOT", { skip: process.platform !== "win32" }, async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "bridge-windows-entry-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(path.join(root, "hooks", "hooks.json"), "utf8"));
  const command = manifest.hooks.UserPromptSubmit[0].hooks[0].commandWindows;
  const code = /^node -e "([^"]+)"$/.exec(command)?.[1];
  assert.ok(code);
  const result = await executeProcess(process.execPath, ["-e", code], {
    stdinText: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "windows-entry-session", cwd: data, prompt: "/claude help" }),
    environment: { ...process.env, PLUGIN_DATA: data, PLUGIN_ROOT: root }, inheritFullEnvironment: true,
  });
  assert.equal(result.exitCode, 0);
  assert.match(JSON.parse(result.stdout).reason, /Codex App 与 CLI 通用/);
});
