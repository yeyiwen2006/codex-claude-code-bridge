#!/usr/bin/env node

import readline from "node:readline";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getClaudeHealth, runClaude } from "./lib/claude-runner.mjs";
import {
  EFFORT_LEVELS,
  CUSTOMIZATION_SOURCES,
  InputError,
  assertAuthorizedDirectories,
  normalizeAuthorizationInput,
  normalizeRunInput,
  pathsEqual,
  pathsOverlap,
} from "./lib/validation.mjs";

const SERVER_NAME = "codex-claude-code-bridge";
const SERVER_VERSION = "0.3.5";
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const AUTHORIZATION_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_CONCURRENT_CLAUDE_CALLS = 2;

const COMMON_RUN_PROPERTIES = {
  prompt: {
    type: "string",
    minLength: 1,
    maxLength: 200000,
    description: "The complete task to give Claude Code. Include goals, constraints, and expected verification.",
  },
  working_directory: {
    type: "string",
    minLength: 1,
    description: "Absolute path to the user-approved project directory in which Claude Code should run.",
  },
  extra_directories: {
    type: "array",
    maxItems: 20,
    uniqueItems: true,
    items: { type: "string", minLength: 1 },
    description: "Optional additional absolute directories that Claude Code may access via --add-dir.",
  },
  timeout_seconds: {
    type: "integer",
    minimum: 1,
    maximum: 3600,
    default: 1800,
    description: "Hard process timeout. The default is 30 minutes.",
  },
  session_id: {
    type: "string",
    pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    description: "A Claude Code session UUID returned by a previous call in the same project.",
  },
  fork_session: {
    type: "boolean",
    default: false,
    description: "When resuming, fork to a new session instead of continuing the original session.",
  },
  persist_session: {
    type: "boolean",
    default: false,
    description: "Persist the Claude Code session so its returned session_id can be resumed.",
  },
  customization_sources: {
    type: "string",
    enum: CUSTOMIZATION_SOURCES,
    default: "safe",
    description: "Choose Claude customization loading. safe disables customizations; user/project/all load the corresponding trusted Claude settings, hooks, plugins, and skills. plugin-only is reserved for the deterministic command bridge.",
  },
  allow_plugin_tools: {
    type: "boolean",
    default: false,
    description: "Allow MCP tools contributed by loaded Claude plugins. Keep false unless the user explicitly trusts those plugin tools and their external actions.",
  },
  image_paths: {
    type: "array",
    maxItems: 20,
    uniqueItems: true,
    items: { type: "string", minLength: 1 },
    description: "Optional absolute PNG, JPEG, GIF, or WebP paths inside the authorized project root. Deterministic chat commands use a separate private clipboard queue.",
  },
  model: {
    type: "string",
    minLength: 1,
    maxLength: 128,
    description: "Optional Claude Code model alias or full model name. Omit to use the user's configured default.",
  },
  effort: {
    type: "string",
    enum: EFFORT_LEVELS,
    description: "Optional Claude Code effort level.",
  },
  max_budget_usd: {
    type: "number",
    exclusiveMinimum: 0,
    maximum: 1000,
    description: "Optional Claude Code API budget ceiling for this non-interactive invocation.",
  },
  authorization_id: {
    type: "string",
    pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    description: "Directory capability returned by claude_code_authorize_directory in this MCP server session.",
  },
};

export const TOOLS = Object.freeze([
  {
    name: "claude_code_health",
    title: "Check Claude Code",
    description: "Check whether the local Claude Code CLI is installed and authenticated. Returns only non-personal status fields.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "claude_code_authorize_directory",
    title: "Authorize a Project Directory",
    description: "Grant this MCP server a temporary capability for one user-approved project root. Filesystem roots, the entire home directory, and Windows network shares are rejected. Authorization lasts up to four hours and disappears when the server stops.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          minLength: 1,
          description: "Absolute path to the specific project root the user approves for Claude Code access.",
        },
      },
      required: ["directory"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "claude_code_plan",
    title: "Ask Claude Code to Plan",
    description: "Run Claude Code in plan mode for read-only analysis. This tool always disables project/user customizations, plugin tools, and session persistence. It may still read authorized files and use Claude's network-backed model.",
    inputSchema: {
      type: "object",
      properties: COMMON_RUN_PROPERTIES,
      required: ["prompt", "working_directory", "authorization_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "claude_code_run",
    title: "Run Claude Code with Changes",
    description: "Model-directed fallback for running local Claude Code with project edits. Unlike deterministic claude hook commands, this MCP fallback exposes file tools only, denies shell and web tools, and does not support bypass or arbitrary CLI flags.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_RUN_PROPERTIES,
        permission_mode: {
          type: "string",
          enum: ["acceptEdits", "auto", "dontAsk"],
          default: "acceptEdits",
          description: "Claude permission mode for this MCP fallback's fixed file-only tool set. acceptEdits is the default; dontAsk pre-approves only listed file tools; auto uses Claude's classifier when supported.",
        },
      },
      required: ["prompt", "working_directory", "authorization_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
]);

const activeRequests = new Map();
const directoryAuthorizations = new Map();
const activeWriteScopes = new Map();
const activeSessions = new Set();
const sessionRoots = new Map();
let activeClaudeCalls = 0;

function authorizationFor(identifier) {
  if (typeof identifier !== "string") {
    throw new InputError("'authorization_id' is required. Authorize the project directory first.");
  }
  const authorization = directoryAuthorizations.get(identifier);
  if (!authorization) {
    throw new InputError("Directory authorization is unknown or belongs to a previous MCP server session.");
  }
  if (authorization.expiresAt <= Date.now()) {
    directoryAuthorizations.delete(identifier);
    throw new InputError("Directory authorization has expired; ask the user to authorize it again.");
  }
  return authorization;
}

function writeScopesFor(input) {
  return [input.workingDirectory, ...input.extraDirectories];
}

async function runWithLocks(input, isModification, operation) {
  if (activeClaudeCalls >= MAX_CONCURRENT_CLAUDE_CALLS) {
    throw new InputError("The bridge already has the maximum number of active Claude Code calls.");
  }
  const requestedScopes = isModification ? writeScopesFor(input) : [];
  if (isModification) {
    for (const activeScopes of activeWriteScopes.values()) {
      if (requestedScopes.some((requested) => activeScopes.some((active) => pathsOverlap(requested, active)))) {
        throw new InputError("Another Claude Code modification is already running in an overlapping directory.");
      }
    }
  }
  if (input.sessionId && activeSessions.has(input.sessionId)) {
    throw new InputError("This Claude Code session is already active; resume calls must be serialized.");
  }

  const lockIdentity = Symbol("write-operation");
  activeClaudeCalls += 1;
  if (isModification) {
    activeWriteScopes.set(lockIdentity, requestedScopes);
  }
  if (input.sessionId) {
    activeSessions.add(input.sessionId);
  }
  try {
    return await operation();
  } finally {
    if (isModification) {
      activeWriteScopes.delete(lockIdentity);
    }
    if (input.sessionId) {
      activeSessions.delete(input.sessionId);
    }
    activeClaudeCalls -= 1;
  }
}

function assertSessionRoot(input, authorizationRoot) {
  if (!input.sessionId) {
    return;
  }
  const boundRoot = sessionRoots.get(input.sessionId);
  if (!boundRoot) {
    throw new InputError("This session was not created by the current Codex Claude Code Bridge server session.");
  }
  if (!pathsEqual(boundRoot, authorizationRoot)) {
    throw new InputError("Claude Code sessions cannot be resumed under a different authorized project root.");
  }
}

function bindReturnedSession(input, authorizationRoot, result) {
  if (!input.persistSession || typeof result.session_id !== "string") {
    return;
  }
  const existingRoot = sessionRoots.get(result.session_id);
  if (existingRoot && !pathsEqual(existingRoot, authorizationRoot)) {
    throw new InputError("Claude Code returned a session ID already bound to a different project root.");
  }
  sessionRoots.set(result.session_id, authorizationRoot);
}

async function executeAuthorizedClaude(input, authorizationRoot, isModification, signal) {
  assertAuthorizedDirectories(authorizationRoot, input);
  assertSessionRoot(input, authorizationRoot);
  const result = await runWithLocks(
    input,
    isModification,
    () => runClaude(input, { signal }),
  );
  bindReturnedSession(input, authorizationRoot, result);
  return toolSuccess(result);
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: "2.0", id, error };
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

function errorCode(error) {
  if (error instanceof InputError) {
    return "INVALID_ARGUMENT";
  }
  if (error && typeof error === "object" && typeof error.code === "string") {
    return error.code;
  }
  return "CLAUDE_CODE_FAILED";
}

function toolFailure(error) {
  const failure = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    error_code: errorCode(error),
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(failure, null, 2) }],
    structuredContent: failure,
  };
}

function toolSuccess(result) {
  const bridgeMetadata = {
    ok: result.ok,
    session_id: result.session_id ?? null,
    exit_code: result.exit_code ?? null,
    elapsed_ms: result.elapsed_ms,
  };
  if (result.permission_denials?.length) {
    bridgeMetadata.permission_denials = result.permission_denials;
  }
  if (result.total_cost_usd !== undefined) {
    bridgeMetadata.total_cost_usd = result.total_cost_usd;
  }

  const primaryText = result.result || (result.ok
    ? "Claude Code completed without a textual result."
    : "Claude Code failed without a textual result.");
  const text = `${primaryText}\n\n[Claude Code bridge metadata]\n${JSON.stringify(bridgeMetadata, null, 2)}`;
  return {
    ...(result.ok ? {} : { isError: true }),
    content: [{ type: "text", text }],
    structuredContent: result,
  };
}

async function invokeTool(name, rawArguments, signal) {
  if (name === "claude_code_health") {
    const argumentsObject = rawArguments ?? {};
    if (argumentsObject === null || typeof argumentsObject !== "object" || Array.isArray(argumentsObject)) {
      throw new InputError("Tool arguments must be a JSON object.");
    }
    if (Object.keys(argumentsObject).length > 0) {
      throw new InputError("claude_code_health does not accept arguments.");
    }
    const health = await getClaudeHealth({ signal });
    return {
      ...(health.installed && health.authenticated ? {} : { isError: true }),
      content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
      structuredContent: health,
    };
  }

  if (name === "claude_code_authorize_directory") {
    const argumentsObject = rawArguments ?? {};
    if (argumentsObject === null || typeof argumentsObject !== "object" || Array.isArray(argumentsObject)) {
      throw new InputError("Tool arguments must be a JSON object.");
    }
    const unknownKeys = Object.keys(argumentsObject).filter((key) => key !== "directory");
    if (unknownKeys.length > 0) {
      throw new InputError(`Unknown authorization argument(s): ${unknownKeys.join(", ")}.`);
    }
    const authorizedRoot = await normalizeAuthorizationInput(argumentsObject);
    const authorizationId = randomUUID();
    const expiresAt = Date.now() + AUTHORIZATION_TTL_MS;
    directoryAuthorizations.set(authorizationId, { root: authorizedRoot, expiresAt });
    const result = {
      ok: true,
      authorization_id: authorizationId,
      authorized_root: authorizedRoot,
      expires_at: new Date(expiresAt).toISOString(),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }

  if (name === "claude_code_plan") {
    const authorization = authorizationFor(rawArguments?.authorization_id);
    const { authorization_id: _authorizationId, ...runArguments } = rawArguments ?? {};
    const input = await normalizeRunInput({
      ...runArguments,
      permission_mode: "plan",
      persist_session: false,
      customization_sources: "safe",
      allow_plugin_tools: false,
    });
    return executeAuthorizedClaude(input, authorization.root, false, signal);
  }

  if (name === "claude_code_run") {
    const authorization = authorizationFor(rawArguments?.authorization_id);
    const { authorization_id: _authorizationId, ...runArguments } = rawArguments ?? {};
    const input = await normalizeRunInput(runArguments);
    return executeAuthorizedClaude(input, authorization.root, true, signal);
  }

  throw new InputError(`Unknown tool '${name}'.`);
}

export async function handleMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  const { id, method, params } = message;

  if (method === "notifications/cancelled") {
    const cancelledId = params?.requestId;
    activeRequests.get(requestKey(cancelledId))?.abort();
    return undefined;
  }

  if (method === "notifications/initialized") {
    return undefined;
  }

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(params?.protocolVersion)
        ? params.protocolVersion
        : FALLBACK_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      instructions: "Prefer deterministic claude commands when the user asks for them. The Codex App also accepts the /claude alias, but Codex CLI requires the form without a slash. For model-directed calls, use claude_code_plan for read-only work and claude_code_run only when the user permits changes. Shell and web tools are unavailable; verify file changes afterward.",
    });
  }

  if (method === "ping") {
    return jsonRpcResult(id, {});
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    if (typeof params?.name !== "string") {
      return jsonRpcError(id, -32602, "tools/call requires a tool name.");
    }
    const controller = new AbortController();
    const typedRequestKey = requestKey(id);
    activeRequests.set(typedRequestKey, controller);
    try {
      const result = await invokeTool(params.name, params.arguments ?? {}, controller.signal);
      return jsonRpcResult(id, result);
    } catch (error) {
      return jsonRpcResult(id, toolFailure(error));
    } finally {
      if (activeRequests.get(typedRequestKey) === controller) {
        activeRequests.delete(typedRequestKey);
      }
    }
  }

  if (typeof method === "string" && method.startsWith("notifications/")) {
    return undefined;
  }
  return jsonRpcError(id ?? null, -32601, `Method not found: ${String(method)}`);
}

export function startServer() {
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  input.on("line", async (line) => {
    if (!line.trim()) {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeMessage(jsonRpcError(null, -32700, "Parse error"));
      return;
    }

    try {
      const response = await handleMessage(message);
      if (response !== undefined) {
        writeMessage(response);
      }
    } catch (error) {
      writeMessage(jsonRpcError(message?.id ?? null, -32603, "Internal error", {
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  input.on("close", () => {
    for (const controller of activeRequests.values()) {
      controller.abort();
    }
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  startServer();
}
