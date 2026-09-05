import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildNativeClaudeArguments } from "../server/lib/claude-runner.mjs";
import {
  InputError,
  normalizeAuthorizationInput,
  normalizeRunInput,
  pathIsWithinRoot,
} from "../server/lib/validation.mjs";

let temporaryDirectory;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-claude-code-bridge-validation-"));
});

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("normalizes safe modification defaults", async () => {
  const input = await normalizeRunInput({
    prompt: "Implement the requested change.",
    working_directory: temporaryDirectory,
  });

  assert.equal(input.permissionMode, "acceptEdits");
  assert.equal(input.timeoutSeconds, 1800);
  assert.equal(input.persistSession, false);
  assert.equal(input.customizationSources, "safe");
  assert.equal(input.allowPluginTools, false);
  assert.deepEqual(input.imagePaths, []);
  assert.deepEqual(input.pluginDirectories, []);
  assert.equal(path.isAbsolute(input.workingDirectory), true);
});

test("rejects relative working directories", async () => {
  await assert.rejects(
    normalizeRunInput({ prompt: "test", working_directory: "." }),
    (error) => error instanceof InputError && /absolute path/.test(error.message),
  );
});

test("preserves official extended-context model names in native arguments", async () => {
  for (const model of ["opus[1m]", "sonnet[1m]", "claude-opus-4-8[1m]"]) {
    const input = await normalizeRunInput({ prompt: "test", working_directory: temporaryDirectory, model });
    const args = buildNativeClaudeArguments(input);
    assert.equal(args[args.indexOf("--model") + 1], model);
  }
});

test("rejects malformed model suffixes and model argument injection", async () => {
  for (const model of ["opus[2m]", "opus[1m][1m]", "opus[1m] --help", "--help", "opus;echo", "opus\nsonnet", 42]) {
    await assert.rejects(normalizeRunInput({ prompt: "test", working_directory: temporaryDirectory, model }), InputError);
  }
});

test("accepts all native Claude permission modes, including bypass", async () => {
  for (const permissionMode of ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]) {
    const input = await normalizeRunInput({
      prompt: "test",
      working_directory: temporaryDirectory,
      permission_mode: permissionMode,
    });
    assert.equal(input.permissionMode, permissionMode);
  }
});

test("requires a session id before forking", async () => {
  await assert.rejects(
    normalizeRunInput({
      prompt: "test",
      working_directory: temporaryDirectory,
      fork_session: true,
    }),
    (error) => error instanceof InputError && /requires 'session_id'/.test(error.message),
  );
});

test("rejects removed shell permission arguments", async () => {
  await assert.rejects(
    normalizeRunInput({
      prompt: "test",
      working_directory: temporaryDirectory,
      allowed_tools: ["Bash(npm test *)"],
    }),
    (error) => error instanceof InputError && /Unknown argument/.test(error.message),
  );
});

test("requires a non-safe customization source before plugin tools", async () => {
  await assert.rejects(
    normalizeRunInput({
      prompt: "test",
      working_directory: temporaryDirectory,
      allow_plugin_tools: true,
    }),
    (error) => error instanceof InputError && /non-safe customization/.test(error.message),
  );
});

test("rejects authorization of a filesystem root", async () => {
  await assert.rejects(
    normalizeAuthorizationInput({ directory: path.parse(temporaryDirectory).root }),
    (error) => error instanceof InputError && /filesystem root/.test(error.message),
  );
});

test("path boundary logic rejects a sibling with a matching prefix", () => {
  const root = path.join(path.parse(temporaryDirectory).root, "repo");
  assert.equal(pathIsWithinRoot(root, path.join(root, "src")), true);
  assert.equal(pathIsWithinRoot(root, `${root}-other`), false);
});
