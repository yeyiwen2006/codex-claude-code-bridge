import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStreamJsonOutput } from "../server/lib/claude-runner.mjs";
import { formatClaudeJobResult } from "../server/lib/claude-result-text.mjs";
const target = "C:/fixture/project/app-write-test.txt";
const request = { input: { permissionMode: "default", customizationSources: "safe" } };
const call = (id, filePath, parent = null) => ({ type: "assistant", parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id, name: "Write", input: { file_path: filePath, content: "中文" } }] } });
const reply = (id, error = false, parent = null) => ({ type: "user", parent_tool_use_id: parent,
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: error ? "Denied" : "Created" }] } });
const operations = records => parseStreamJsonOutput(records.map(JSON.stringify).join("\n")).fileOperations;

test("replaces a conflicting completion summary with successful tool evidence and retains the original for diagnosis", () => {
  const original = "已完成。写入：`/Users/example/other/app-write-test.txt`";
  const text = formatClaudeJobResult({ ok: true, result: original, file_operations: operations([call("a", target), reply("a")]) }, request);
  const [body, diagnostic] = text.split("\n\n[Codex Claude Code Bridge 元数据]\n");
  assert.match(body, /C:\/fixture\/project\/app-write-test.txt/);
  assert.doesNotMatch(body, /\/Users\/example/);
  assert.match(body, /路径.*不一致/);
  assert.equal(JSON.parse(diagnostic).claude_original_result, original);
});

test("does not claim a denied or unanswered file request succeeded", () => {
  const records = operations([call("denied", target), reply("denied", true), call("pending", "C:/fixture/pending.txt")]);
  assert.deepEqual(records.map(record => record.status), ["failed", "unconfirmed"]);
  const text = formatClaudeJobResult({ ok: false, result: "Failed", file_operations: records }, request);
  assert.doesNotMatch(text, /工具返回成功/);
  assert.match(text, /工具返回失败/);
  assert.match(text, /未收到工具完成结果/);
});

test("matches results by tool id and parent and deduplicates replayed calls", () => {
  const a = call("a", target);
  const records = operations([a, a, reply("a", false, "different-parent"), call("b", "C:/fixture/b.txt"), reply("b")]);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.status), ["unconfirmed", "succeeded"]);
});

test("does not flag Windows separator or case differences or unrelated files", () => {
  const result = formatClaudeJobResult({ ok: true, result: "Written `c:\\FIXTURE\\project\\app-write-test.txt`; see `/elsewhere/notes.txt`.", file_operations: operations([call("a", target), reply("a")]) }, request);
  assert.doesNotMatch(result, /reported_path_conflicts/);
  assert.match(result, /Claude 文字说明/);
});

test("does not infer a correction when successful files share a basename", () => {
  const fileOperations = operations([call("a", target), reply("a"), call("b", "C:/fixture/other/app-write-test.txt"), reply("b")]);
  const text = formatClaudeJobResult({ ok: true, result: "Compare `/third/app-write-test.txt`", file_operations: fileOperations }, request);
  assert.doesNotMatch(text, /reported_path_conflicts/);
});
