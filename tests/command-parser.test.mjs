import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CommandError,
  parseClaudeCommand,
  validateSkillName,
} from "../server/lib/command-parser.mjs";

test("leaves ordinary prompts untouched", () => {
  assert.equal(parseClaudeCommand("请用 Codex 修复这个问题"), null);
  assert.equal(parseClaudeCommand("/claudette run -- no"), null);
});

test("parses a raw task after the command terminator", () => {
  assert.deepEqual(parseClaudeCommand("/claude run -- 修复登录问题，并保留 --flag"), {
    kind: "run",
    prompt: "修复登录问题，并保留 --flag",
  });
});

test("parses native permission modes and runtime approval commands", () => {
  assert.deepEqual(parseClaudeCommand("/claude run --permission bypass -- 执行任务"), {
    kind: "run",
    prompt: "执行任务",
    permissionOverride: "bypass",
  });
  assert.deepEqual(parseClaudeCommand("/claude mode accept-edits"), {
    kind: "mode",
    value: "accept-edits",
  });
  assert.deepEqual(parseClaudeCommand("/claude allow a1b2c3d4 session"), {
    kind: "allow",
    approvalId: "a1b2c3d4",
    scope: "session",
  });
  assert.deepEqual(parseClaudeCommand("/claude deny a1b2c3d4 -- 不要删除"), {
    kind: "deny",
    approvalId: "a1b2c3d4",
    reason: "不要删除",
  });
});

test("parses quoted plugin paths without shell expansion", () => {
  assert.deepEqual(parseClaudeCommand('/claude plugin add "C:\\My Plugins\\reviewer"'), {
    kind: "plugin-add",
    value: "C:\\My Plugins\\reviewer",
  });
});

test("supports deterministic multiple-image queue commands", () => {
  assert.deepEqual(parseClaudeCommand("/claude image add"), { kind: "image-add", force: false });
  assert.deepEqual(parseClaudeCommand("/claude image add --force"), { kind: "image-add", force: true });
  assert.deepEqual(parseClaudeCommand("/claude image run -- 对比全部图片"), {
    kind: "image-run",
    prompt: "对比全部图片",
  });
});

test("rejects missing prompts and unterminated quotes", () => {
  assert.throws(() => parseClaudeCommand("/claude run"), CommandError);
  assert.throws(() => parseClaudeCommand('/claude plugin add "C:\\broken'), CommandError);
});

test("validates normal and namespaced Claude skill names", () => {
  assert.equal(validateSkillName("simplify"), "simplify");
  assert.equal(validateSkillName("reviewer:security-check"), "reviewer:security-check");
  assert.throws(() => validateSkillName("../escape"), CommandError);
});
