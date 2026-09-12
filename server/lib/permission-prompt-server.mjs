#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { BRIDGE_VERSION } from "./version.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";
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

async function mutateSession(context, operation) {
  return withStateLock(context.dataRoot, sessionLockName(context.sessionId), async () => {
    const state = await loadSessionState(context.dataRoot, context.sessionId);
    const result = await operation(state);
    if (result !== false) await saveSessionState(context.dataRoot, context.sessionId, state);
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

export async function requestPermission(argumentsObject, context, options = {}) {
  const { dataRoot, sessionId, jobId } = context;
  if (options.signal?.aborted) return { behavior: "deny", message: "权限请求已取消。" };
  const toolName = argumentsObject.tool_name;
  const input = argumentsObject.input;
  if (typeof toolName !== "string" || input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Permission prompt tool received invalid tool_name or input.");
  }
  const approvalId = randomUUID().replaceAll("-", "").slice(0, 8);
  await mutateSession(context, async (state) => {
    if (state.activeJob?.id !== jobId) throw new Error("The active job changed while awaiting permission.");
    if (state.activeJob.cancelRequested) throw new Error("The active job was cancelled.");
    if (state.sessionEnded || !["starting", "running", "waiting"].includes(state.activeJob.status)) {
      throw new Error("The active job is no longer running.");
    }
    if (state.activeJob.pendingApproval) throw new Error("The active job already has a pending permission request.");
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
    if (options.signal?.aborted) {
      await mutateSession(context, async (state) => {
        if (state.activeJob?.id === jobId && state.activeJob.status === "waiting"
          && state.activeJob.pendingApproval?.id === approvalId) {
          state.activeJob.status = "running";
          state.activeJob.pendingApproval = null;
          state.activeJob.decision = null;
          state.activeJob.updatedAt = Date.now();
        } else {
          return false;
        }
      });
      return { behavior: "deny", message: "权限请求已取消。" };
    }
    const state = await loadSessionState(dataRoot, sessionId);
    const job = state.activeJob;
    if (!job || job.id !== jobId || job.cancelRequested || state.sessionEnded) {
      return { behavior: "deny", message: "用户取消了 Claude Code 任务。" };
    }
    if (job.status !== "waiting" || job.pendingApproval?.id !== approvalId) {
      return { behavior: "deny", message: "权限请求已过期。" };
    }
    if (job.decision?.approvalId === approvalId) {
      // Recheck and consume under the lock: cancellation or finalization can
      // win after the read above, and must never become a late tool approval.
      const decision = await mutateSession(context, async (mutable) => {
        const active = mutable.activeJob;
        if (options.signal?.aborted || mutable.sessionEnded || active?.id !== jobId
          || active.cancelRequested || active.status !== "waiting"
          || active.pendingApproval?.id !== approvalId || active.decision?.approvalId !== approvalId) {
          return false;
        }
        const consumed = active.decision;
        active.status = "running";
        active.pendingApproval = null;
        active.decision = null;
        active.updatedAt = Date.now();
        return consumed;
      });
      if (!decision) continue;
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

async function handle(message, options = {}) {
  if (message.method === "initialize") {
    return response(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "codex-claude-code-bridge-permission", version: BRIDGE_VERSION },
    });
  }
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
    const decision = await requestPermission(message.params.arguments ?? {}, { dataRoot, sessionId, jobId }, options);
    return response(message.id, { content: [{ type: "text", text: JSON.stringify(decision) }] });
  }
  return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "Method not found" } };
}

async function startPermissionServer() {
  validateIdentifier(sessionId, "Session ID");
  validateIdentifier(jobId, "Job ID");
  if (!dataRoot || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(dataRoot)) throw new Error("PLUGIN_DATA path must be absolute.");

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const requests = new Map();
  const tasks = new Set();
  let permissions = Promise.resolve();
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let incoming;
      try {
        incoming = JSON.parse(line);
      } catch (error) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } });
        continue;
      }
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP request must be a JSON object." } });
        continue;
      }
      const hasId = Object.hasOwn(incoming, "id");
      const validId = typeof incoming.id === "string"
        || (typeof incoming.id === "number" && Number.isFinite(incoming.id));
      if (incoming.jsonrpc !== "2.0" || typeof incoming.method !== "string" || (hasId && !validId)) {
        send({ jsonrpc: "2.0", id: validId ? incoming.id : null, error: { code: -32600, message: "Invalid Request" } });
        continue;
      }
      if (incoming.params !== undefined && (incoming.params === null
        || typeof incoming.params !== "object" || Array.isArray(incoming.params))) {
        if (hasId) send({ jsonrpc: "2.0", id: incoming.id, error: { code: -32602, message: "Request params must be a JSON object." } });
        continue;
      }
      if (!hasId) {
        if (incoming.method === "notifications/cancelled") requests.get(incoming.params?.requestId)?.abort();
        continue;
      }
      if (requests.has(incoming.id)) {
        send(errorResponse(incoming.id, new Error("A request with this ID is already pending.")));
        continue;
      }
      const controller = new AbortController();
      requests.set(incoming.id, controller);
      const execute = async () => {
        try {
          if (controller.signal.aborted) return;
          const outgoing = await handle(incoming, { signal: controller.signal });
          if (outgoing && !controller.signal.aborted) send(outgoing);
        } catch (error) {
          if (!controller.signal.aborted) send(errorResponse(incoming.id, error));
        } finally {
          requests.delete(incoming.id);
        }
      };
      // Only approvals share the single on-disk slot. Keep transport control
      // messages responsive while a user is deciding or an approval is queued.
      const task = incoming.method === "tools/call" ? permissions.then(execute) : execute();
      if (incoming.method === "tools/call") permissions = task;
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    }
  } finally {
    for (const controller of requests.values()) controller.abort();
    await Promise.allSettled(tasks);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await startPermissionServer();
}
