import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  composePromptWithCodexConversation,
  readCodexConversation,
} from "../server/lib/codex-transcript.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function transcript(records) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-bridge-transcript-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "rollout.jsonl");
  await writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n{incomplete`,
    "utf8",
  );
  return filePath;
}

function message(role, text, phase) {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role,
      ...(phase ? { phase } : {}),
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  };
}

test("extracts only visible user and assistant conversation", async () => {
  const filePath = await transcript([
    message("developer", "hidden developer instruction"),
    message("user", "实现登录功能"),
    { type: "response_item", payload: { type: "reasoning", summary: [{ text: "hidden reasoning" }] } },
    message("assistant", "已经修改认证模块。", "commentary"),
    { type: "response_item", payload: { type: "custom_tool_call_output", output: "secret tool output" } },
    message("assistant", "还需要补充测试。", "final_answer"),
    message("user", "/claude run -- 继续"),
  ]);

  const result = await readCodexConversation(filePath, {
    currentPrompt: "/claude run -- 继续",
  });
  assert.equal(result.available, true);
  assert.equal(result.messageCount, 3);
  assert.equal(result.malformedLines, 1);
  assert.match(result.text, /\[用户\]\n实现登录功能/);
  assert.match(result.text, /\[Codex 助手\]\n已经修改认证模块/);
  assert.match(result.text, /还需要补充测试/);
  assert.doesNotMatch(result.text, /developer|reasoning|tool output|\/claude run/);
});

test("keeps the current task first so Claude skill commands remain invocable", () => {
  const result = composePromptWithCodexConversation("/reviewer:inspect fixture", {
    text: "[用户]\n检查权限边界",
  });
  assert.ok(result.prompt.startsWith("/reviewer:inspect fixture\n"));
  assert.match(result.prompt, /<codex_conversation>/);
  assert.match(result.prompt, /检查权限边界/);
  assert.equal(result.contextTruncated, false);
});

test("keeps a large current task intact and trims inherited context to the prompt limit", () => {
  const task = `当前任务 ${"T".repeat(150_000)}`;
  const result = composePromptWithCodexConversation(task, {
    text: `历史上下文 ${"H".repeat(100_000)}`,
  });
  assert.ok(result.prompt.startsWith(task));
  assert.ok(result.prompt.length <= 200_000);
  assert.equal(result.contextTruncated, true);
});

test("preserves the beginning and recent tail when conversation is long", async () => {
  const filePath = await transcript([
    message("user", `开头目标 ${"A".repeat(1_500)}`),
    message("assistant", `中间内容 ${"B".repeat(6_000)}`, "commentary"),
    message("user", `最近要求 ${"C".repeat(1_500)}`),
  ]);
  const result = await readCodexConversation(filePath, { maxCharacters: 4_000 });
  assert.equal(result.truncated, true);
  assert.match(result.text, /开头目标/);
  assert.match(result.text, /中间较早的对话因长度限制已省略/);
  assert.match(result.text, /最近要求/);
  assert.ok(result.text.length <= 4_000);
});
