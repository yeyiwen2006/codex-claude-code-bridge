#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import readline from "node:readline";
import {
  loadSessionState,
  saveSessionState,
  sessionLockName,
  withStateLock,
} from "./state-store.mjs";

const [dataRoot, sessionId, jobId] = process.argv.slice(2);
const TOOL_NAME = "request";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

async function mutateSession(operation) {
  return withStateLock(dataRoot, sessionLockName(sessionId), async () => {
    const state = await loadSessionState(dataRoot, sessionId);
    const result = await operation(state);
    await saveSessionState(dataRoot, sessionId, state);
    return result;
  });
}

function displayInput(input) {
  const text = JSON.stringify(input, null, 2);
  return text.length <= 24_000 ? text : `${text.slice(0, 24_000)}\n…（参数显示已截断）`;
}

function permissionUpdates(scope, suggestions) {
  if (scope === "once") return [];
  const destinations = scope === "session"
    ? new Set(["session", "cliArg"])
    : scope === "user"
      ? new Set(["userSettings"])
      : new Set(["localSettings", "projectSettings"]);
  return (Array.isArray(suggestions) ? suggestions : []).filter((entry) => destinations.has(entry?.destination));
}

async function requestPermission(argumentsObject) {
  const toolName = argumentsObject.tool_name;
  const input = argumentsObject.input;
  if (typeof toolName !== "string" || input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Permission prompt tool received invalid tool_name or input.");
  }
  const approvalId = randomUUID().replaceAll("-", "").slice(0, 8);
  await mutateSession(async (state) => {
    if (state.activeJob?.id !== jobId) throw new Error("The active job changed while awaiting permission.");
    state.activeJob.status = "waiting";
    state.activeJob.pendingApproval = {
      id: approvalId,
      toolName,
      inputText: displayInput(input),
      title: argumentsObject.title ?? null,
      displayName: argumentsObject.display_name ?? null,
      description: argumentsObject.description ?? null,
      decisionReason: argumentsObject.decision_reason ?? null,
      blockedPath: argumentsObject.blocked_path ?? null,
      createdAt: Date.now(),
    };
    state.activeJob.decision = null;
    state.activeJob.updatedAt = Date.now();
  });

  while (true) {
    const state = await loadSessionState(dataRoot, sessionId);
    const job = state.activeJob;
    if (!job || job.id !== jobId || job.cancelRequested) {
      return { behavior: "deny", message: "用户取消了 Claude Code 任务。" };
    }
    if (job.decision?.approvalId === approvalId) {
      const decision = job.decision;
      await mutateSession(async (mutable) => {
        if (mutable.activeJob?.id === jobId) {
          mutable.activeJob.status = "running";
          mutable.activeJob.pendingApproval = null;
          mutable.activeJob.decision = null;
          mutable.activeJob.updatedAt = Date.now();
        }
      });
      if (decision.action === "deny") {
        return { behavior: "deny", message: decision.reason || "用户拒绝了该工具调用。" };
      }
      if (decision.action === "answer") {
        return {
          behavior: "allow",
          updatedInput: { questions: input.questions ?? [], answers: decision.answers ?? {} },
        };
      }
      const updates = permissionUpdates(decision.scope, argumentsObject.permission_suggestions);
      return {
        behavior: "allow",
        updatedInput: input,
        ...(updates.length > 0 ? { updatedPermissions: updates } : {}),
      };
    }
    await delay(150);
  }
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, error) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
}

async function handle(message) {
  if (message.method === "initialize") {
    return response(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "codex-claude-code-bridge-permission", version: "0.3.4" },
    });
  }
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return undefined;
  if (message.method === "ping") return response(message.id, {});
  if (message.method === "tools/list") {
    return response(message.id, { tools: [{
      name: TOOL_NAME,
      description: "Resolve a Claude Code permission request through the Codex bridge.",
      inputSchema: {
        type: "object",
        properties: {
          tool_name: { type: "string" },
          input: { type: "object" },
          tool_use_id: { type: "string" },
          permission_suggestions: { type: "array", items: { type: "object" } },
        },
        required: ["tool_name", "input"],
        additionalProperties: true,
      },
    }] });
  }
  if (message.method === "tools/call" && message.params?.name === TOOL_NAME) {
    const decision = await requestPermission(message.params.arguments ?? {});
    return response(message.id, { content: [{ type: "text", text: JSON.stringify(decision) }] });
  }
  return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "Method not found" } };
}

validateIdentifier(sessionId, "Session ID");
validateIdentifier(jobId, "Job ID");
if (!dataRoot || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(dataRoot)) throw new Error("PLUGIN_DATA path must be absolute.");

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let outgoing;
  let incoming;
  try {
    incoming = JSON.parse(line);
    outgoing = await handle(incoming);
  } catch (error) {
    outgoing = errorResponse(incoming?.id ?? null, error);
  }
  if (outgoing) process.stdout.write(`${JSON.stringify(outgoing)}\n`);
}
