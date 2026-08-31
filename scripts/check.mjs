#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const textExtensions = new Set([".json", ".md", ".mjs", ".ps1", ".yml", ".yaml"]);

async function readJson(relativePath) {
  const text = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  return JSON.parse(text);
}

const plugin = await readJson(".codex-plugin/plugin.json");
const mcp = await readJson(".mcp.json");
const hooks = await readJson("hooks/hooks.json");
const packageManifest = await readJson("package.json");

assert.equal(plugin.name, "claude-code-bridge");
const escapedPackageVersion = packageManifest.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
assert.match(
  plugin.version,
  new RegExp(`^${escapedPackageVersion}(?:\\+codex\\.\\d{14})?$`),
  "plugin version must match the package version, optionally with a Codex cachebuster",
);
assert.equal(plugin.mcpServers, "./.mcp.json");
assert.equal(plugin.skills, "./skills/");
assert.ok(Array.isArray(plugin.interface.defaultPrompt));
assert.ok(plugin.interface.defaultPrompt.length >= 1 && plugin.interface.defaultPrompt.length <= 3);

const server = mcp.mcpServers?.claude_code_bridge;
assert.ok(server, "missing claude_code_bridge MCP configuration");
assert.equal(server.type, "stdio");
assert.equal(server.command, "node");
assert.equal(server.cwd, ".");
assert.deepEqual(server.args, ["./server/index.mjs"]);
assert.equal(server.default_tools_approval_mode, "prompt");
assert.equal(server.tools.claude_code_run.approval_mode, "prompt");
assert.equal(server.tools.claude_code_authorize_directory.approval_mode, "prompt");
assert.ok(Array.isArray(hooks.hooks?.UserPromptSubmit));
assert.ok(Array.isArray(hooks.hooks?.SessionEnd));
assert.match(
  hooks.hooks.UserPromptSubmit[0].hooks[0].commandWindows,
  /command-hook\.mjs/,
);

const sourceFiles = [
  "server/index.mjs",
  "server/lib/claude-runner.mjs",
  "server/lib/validation.mjs",
  "server/lib/command-parser.mjs",
  "server/lib/command-handler.mjs",
  "server/lib/image-queue.mjs",
  "server/lib/state-store.mjs",
  "scripts/command-hook.mjs",
];
for (const relativePath of sourceFiles) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const source = await readFile(absolutePath, "utf8");
  assert.equal(source.includes("--dangerously-skip-permissions"), false, `${relativePath} contains a forbidden flag`);
  assert.equal(source.includes("--allow-dangerously-skip-permissions"), false, `${relativePath} contains a forbidden flag`);
  assert.equal(source.includes('"bypassPermissions"'), false, `${relativePath} contains a forbidden permission mode`);
  assert.equal(source.includes("shell: true"), false, `${relativePath} enables shell command construction`);
  execFileSync(process.execPath, ["--check", absolutePath], { stdio: "inherit" });
}

const skill = await readFile(
  path.join(repositoryRoot, "skills", "use-claude-code", "SKILL.md"),
  "utf8",
);
assert.match(skill, /^---\r?\nname: use-claude-code\r?\n/m);
assert.equal(skill.includes("[TODO:"), false);

async function textFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await textFiles(absolutePath));
    } else if (textExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(absolutePath);
    }
  }
  return files;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
for (const filePath of await textFiles(repositoryRoot)) {
  const decoded = utf8Decoder.decode(await readFile(filePath));
  assert.equal(decoded.includes("\uFFFD"), false, `${filePath} contains a replacement character`);
  assert.equal(decoded.charCodeAt(0) === 0xFEFF, false, `${filePath} contains a UTF-8 BOM`);
}

process.stdout.write("Static checks passed.\n");
