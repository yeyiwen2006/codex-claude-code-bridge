import { randomUUID } from "node:crypto";
import readline from "node:readline";

// Claude Agent SDK's bidirectional protocol works even when safe mode disables MCP.
// Keep stdin open for permission decisions until Claude emits the terminal result.
export function attachClaudeStdioControl(child, prompt, onPermission, fail) {
  const initializeId = randomUUID();
  const requests = new Map();
  const backgroundTasks = new Set();
  let initialized = false;
  let closed = false;
  let permissions = Promise.resolve();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const send = (message) => {
    if (!closed && !child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
    }
  };
  const closeInput = () => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  };
  const processMessage = (message) => {
    if (message.type === "control_response" && message.response?.request_id === initializeId) {
      if (initialized) return;
      if (message.response.subtype !== "success") {
        fail(new Error(`Claude control initialization failed: ${message.response.error ?? "unknown error"}`));
        return;
      }
      initialized = true;
      send({ type: "user", session_id: "", parent_tool_use_id: null,
        message: { role: "user", content: prompt } });
    } else if (message.type === "control_request") {
      const id = message.request_id;
      if (typeof id !== "string" || requests.has(id)) return;
      const controller = new AbortController();
      requests.set(id, controller);
      // The on-disk job has one pending approval, just like the MCP transport.
      permissions = permissions.then(async () => {
        if (closed || controller.signal.aborted) {
          requests.delete(id);
          return;
        }
        try {
          if (message.request?.subtype !== "can_use_tool") {
            throw new Error(`Unsupported Claude control request: ${message.request?.subtype}`);
          }
          const decision = await onPermission(message.request, { signal: controller.signal });
          if (!controller.signal.aborted) {
            send({ type: "control_response", response: {
              subtype: "success", request_id: id, response: decision,
            } });
          }
        } catch (error) {
          if (!controller.signal.aborted) send({ type: "control_response", response: {
            subtype: "error", request_id: id, error: error.message ?? String(error),
          } });
        } finally {
          requests.delete(id);
        }
      });
    } else if (message.type === "control_cancel_request") {
      requests.get(message.request_id)?.abort();
    } else if (message.type === "system" && message.subtype === "task_started"
      && ["local_agent", "local_workflow"].includes(message.task_type)) {
      backgroundTasks.add(message.task_id);
    } else if (message.type === "system" && message.subtype === "task_notification"
      && ["completed", "failed", "stopped"].includes(message.status)) {
      backgroundTasks.delete(message.task_id);
    } else if (message.type === "result" && backgroundTasks.size === 0) {
      closeInput();
    }
  };
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message && typeof message === "object") processMessage(message);
  });
  send({ type: "control_request", request_id: initializeId, request: { subtype: "initialize", hooks: null } });
  return () => {
    closed = true;
    lines.close();
    for (const controller of requests.values()) controller.abort();
    requests.clear();
  };
}
