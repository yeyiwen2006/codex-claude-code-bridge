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

if (prompt === "__FAIL__") {
  process.stderr.write("mock failure\n");
  process.exit(2);
}

if (prompt === "__HANG__") {
  setInterval(() => {}, 1000);
} else if (prompt === "__MALFORMED__") {
  process.stdout.write("plain text fallback");
} else if (prompt === "__CLAUDE_ERROR__") {
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "error_max_budget_usd",
    is_error: false,
    errors: ["mock budget exhausted"],
    session_id: "11111111-2222-4333-8444-555555555555",
    permission_denials: [],
  }));
} else if (prompt === "__ENV__") {
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: process.env.GITHUB_TOKEN ? "secret-present" : "secret-absent",
    session_id: "11111111-2222-4333-8444-555555555555",
    permission_denials: [],
  }));
} else if (prompt === "__BIG__") {
  process.stdout.write("x".repeat(128 * 1024));
} else {
  const resumeIndex = argumentsList.indexOf("--resume");
  const sessionId = resumeIndex >= 0
    ? argumentsList[resumeIndex + 1]
    : "11111111-2222-4333-8444-555555555555";
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `mock:${prompt}`,
    session_id: sessionId,
    num_turns: 1,
    duration_ms: 12,
    duration_api_ms: 5,
    total_cost_usd: 0,
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { mock: { inputTokens: 1, outputTokens: 1 } },
    permission_denials: [],
  }));
}
