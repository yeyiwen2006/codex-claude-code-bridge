import assert from "node:assert/strict";
import { test } from "node:test";
import { formatClaudeJobResult } from "../server/lib/claude-result-text.mjs";

const request = {
  input: {
    permissionMode: "default",
    customizationSources: "all",
  },
  conversation: {
    messageCount: 3,
    truncated: false,
  },
};

test("preserves a non-empty Claude result and includes diagnostics", () => {
  const text = formatClaudeJobResult({
    ok: true,
    result: "finished",
    subtype: "success",
    session_id: "session-1",
    exit_code: 0,
    elapsed_ms: 123,
  }, request);
  assert.match(text, /^finished\n\n/);
  assert.match(text, /\[Codex Claude Code Bridge 元数据\]/);
  assert.match(text, /"empty_result": false/);
  assert.match(text, /"customizations": "all"/);
});

test("explains a successful empty result and exposes protocol diagnostics", () => {
  const text = formatClaudeJobResult({
    ok: true,
    result: "   ",
    subtype: "success",
    exit_code: 0,
    elapsed_ms: 456,
    protocol_warning: "test warning",
    stop_reason: null,
  }, request);
  assert.match(text, /已成功结束，但结果正文为空/);
  assert.match(text, /不会自动重试/);
  assert.match(text, /customizations=plugin-only 或 safe/);
  assert.match(text, /"protocol_warning": "test warning"/);
  assert.match(text, /"empty_result": true/);
});

test("marks text recovered from the assistant stream without calling it empty", () => {
  const text = formatClaudeJobResult({
    ok: true,
    result: "recovered final answer",
    subtype: "success",
    exit_code: 0,
    elapsed_ms: 321,
    original_result_empty: true,
    result_recovered_from_stream: true,
    stream_assistant_messages: 2,
    loaded_plugins: ["fixture-plugin"],
  }, request);
  assert.match(text, /^recovered final answer\n\n/);
  assert.match(text, /"empty_result": false/);
  assert.match(text, /"original_result_empty": true/);
  assert.match(text, /"result_recovered_from_stream": true/);
  assert.match(text, /"fixture-plugin"/);
});
