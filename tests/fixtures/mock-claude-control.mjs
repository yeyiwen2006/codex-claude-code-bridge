import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("9.9.9 (Claude Code)\n");
  process.exit(0);
}
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let prompt;
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "user") {
    prompt = message.message.content;
    if (prompt === "__HANG__") continue;
    const question = prompt === "__QUESTION__";
    send({ type: "control_request", request_id: "permission-1", request: {
      subtype: "can_use_tool", tool_name: question ? "AskUserQuestion" : "Write",
      input: question ? { questions: [{ question: "选择？", options: [{ label: "甲" }, { label: "乙" }] }] }
        : { file_path: "fixture.txt", content: "中文内容" },
      permission_suggestions: [{ type: "addRules", destination: "session", behavior: "allow", rules: [{ toolName: "Write" }] }],
    } });
  } else if (message.type === "control_response") {
    send({ type: "result", subtype: "success", is_error: false,
      result: JSON.stringify(message.response), session_id: "11111111-2222-4333-8444-555555555555" });
  }
}
