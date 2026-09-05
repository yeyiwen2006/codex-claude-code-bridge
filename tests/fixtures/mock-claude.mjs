#!/usr/bin/env node

const argumentsList = process.argv.slice(2);

if (argumentsList.length === 1 && argumentsList[0] === "--version") {
  process.stdout.write("9.9.9 (Claude Code)\n");
  process.exit(0);
}

if (argumentsList[0] === "auth" && argumentsList[1] === "status") {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    authMethod: "test_token",
    apiProvider: "test",
  }));
  process.exit(0);
}

const terminatorIndex = argumentsList.lastIndexOf("--");
let prompt = terminatorIndex >= 0 ? argumentsList[terminatorIndex + 1] : undefined;
if (prompt === undefined) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  prompt = Buffer.concat(chunks).toString("utf8");
}

const outputFormatIndex = argumentsList.indexOf("--output-format");
const outputFormat = outputFormatIndex >= 0 ? argumentsList[outputFormatIndex + 1] : "text";

if (prompt === "__FAIL__") {
  process.stderr.write("mock failure\n");
  process.exit(2);
}

if (prompt === "__HANG__") {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

const delayMatch = /^__DELAY_(\d+)__$/.exec(prompt);
if (delayMatch) {
  await new Promise((resolve) => setTimeout(resolve, Number(delayMatch[1])));
}

if (prompt === "__MALFORMED__") {
  process.stdout.write("plain text fallback");
  process.exit(0);
}

let envelope;
let emittedAssistantText;
if (prompt === "__CLAUDE_ERROR__") {
  envelope = {
    type: "result",
    subtype: "error_max_budget_usd",
    is_error: false,
    errors: ["mock budget exhausted"],
    session_id: "11111111-2222-4333-8444-555555555555",
    permission_denials: [],
  };
} else if (prompt === "__ENV__") {
  envelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: process.env.GITHUB_TOKEN ? "secret-present" : "secret-absent",
    session_id: "11111111-2222-4333-8444-555555555555",
    permission_denials: [],
  };
} else if (prompt === "__BIG__" || prompt === "__BIG_STDERR__") {
  // A forced exit can discard pipe buffers on macOS before the limit is reached.
  const output = prompt === "__BIG_STDERR__" ? process.stderr : process.stdout;
  await new Promise((resolve, reject) => {
    output.write("x".repeat(128 * 1024), (error) => error ? reject(error) : resolve());
  });
  process.exit(0);
} else {
  const resumeIndex = argumentsList.indexOf("--resume");
  const sessionId = resumeIndex >= 0
    ? argumentsList[resumeIndex + 1]
    : "11111111-2222-4333-8444-555555555555";
  const emptyEnvelope = ["__EMPTY__", "__EMPTY_WITH_ASSISTANT__", "__STOP_HOOK_LOOP__"].includes(prompt);
  const resultText = emptyEnvelope ? "" : `mock:${prompt}`;
  emittedAssistantText = prompt === "__EMPTY__"
    ? undefined
    : prompt === "__EMPTY_WITH_ASSISTANT__"
      ? "recovered assistant text"
      : resultText;
  envelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: resultText,
    session_id: sessionId,
    num_turns: 1,
    duration_ms: 12,
    duration_api_ms: 5,
    total_cost_usd: 0,
    stop_reason: "end_turn",
    terminal_reason: "completed",
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { mock: { inputTokens: 1, outputTokens: 1 } },
    permission_denials: [],
  };
}

if (outputFormat === "stream-json") {
  const settingSourcesIndex = argumentsList.indexOf("--setting-sources");
  const isolated = argumentsList.includes("--safe-mode")
    || (settingSourcesIndex >= 0 && argumentsList[settingSourcesIndex + 1] === "");
  process.stdout.write(`${JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: envelope.session_id,
    plugins: isolated ? [] : [{ name: "claude-mem@fixture", path: "/private/fixture" }],
  })}\n`);
  if (prompt === "__STOP_HOOK_LOOP__") {
    for (const record of [
      { type: "assistant", message: { content: [{ type: "text", text: "BRIDGE_APP_OK，中文正常。" }] } },
      { type: "system", subtype: "hook_response", hook_name: "Stop", hook_event: "Stop", exit_code: 2,
        stderr: "Hook error: Transcript path missing or file does not exist: fixture.jsonl" },
      { type: "assistant", message: { content: [{ type: "text", text: "（同前）" }] } },
    ]) process.stdout.write(`${JSON.stringify(record)}\n`);
    emittedAssistantText = undefined;
  }
  if (emittedAssistantText !== undefined) {
    process.stdout.write(`${JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      session_id: envelope.session_id,
      message: {
        role: "assistant",
        content: [{ type: "text", text: emittedAssistantText }],
      },
    })}\n`);
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} else {
  process.stdout.write(JSON.stringify(envelope));
}
