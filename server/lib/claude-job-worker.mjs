#!/usr/bin/env node

import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runClaudeNative } from "./claude-runner.mjs";
import { formatClaudeJobResult } from "./claude-result-text.mjs";
import { recordBridgeExchange } from "./bridge-history.mjs";
import { clearQueuedImages } from "./image-queue.mjs";
import { requestPermission } from "./permission-prompt-server.mjs";
import {
  loadSessionState,
  removeSessionState,
  saveSessionState,
  sessionLockName,
  withStateLock,
} from "./state-store.mjs";

const [dataRoot, sessionId, jobId] = process.argv.slice(2);
const PERMISSION_SERVER = fileURLToPath(new URL("./permission-prompt-server.mjs", import.meta.url));
const PERMISSION_SERVER_NAME = "codex_claude_code_bridge_permission";
const PERMISSION_TOOL_NAME = `mcp__${PERMISSION_SERVER_NAME}__request`;

function validateIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

async function mutateSession(operation) {
  return withStateLock(dataRoot, sessionLockName(sessionId), async () => {
    const state = await loadSessionState(dataRoot, sessionId);
    const result = await operation(state);
    await saveSessionState(dataRoot, sessionId, state);
    return result;
  });
}

async function storeFinal(status, text, error, request) {
  const resultDirectory = path.join(dataRoot, "results", sessionId);
  await mkdir(resultDirectory, { recursive: true, mode: 0o700 });
  const resultPath = path.join(resultDirectory, `${jobId}.md`);
  await writeFile(resultPath, text, { encoding: "utf8", mode: 0o600, flag: "w" });
  await withStateLock(dataRoot, sessionLockName(sessionId), async () => {
    const state = await loadSessionState(dataRoot, sessionId);
    const job = state.activeJob;
    if (!job || job.id !== jobId) return;
    if (request.imageIds?.length > 0) {
      await clearQueuedImages(state, dataRoot, sessionId, request.imageIds);
    }
    state.forkNext = false;
    if (request.input.persistSession && request.resultSessionId) {
      state.claudeSessionId = request.resultSessionId;
      state.claudeSessionRoot = request.authorizationRoot;
    }
    job.status = status;
    job.pendingApproval = null;
    job.decision = null;
    job.resultPath = resultPath;
    job.error = error === undefined || error === null ? null : String(error).slice(0, 4_000);
    job.updatedAt = Date.now();
    if (!state.resultFiles.includes(resultPath)) state.resultFiles.push(resultPath);
    recordBridgeExchange(state, request, {
      id: jobId,
      status,
      text: request.responseText || text,
    });
    if (state.sessionEnded) {
      // Publish cleanup atomically instead of exposing a terminal job first:
      // a result reader could otherwise recreate the state after SessionEnd.
      await clearQueuedImages(state, dataRoot, sessionId);
      for (const storedResult of state.resultFiles) {
        const resolved = path.resolve(storedResult);
        if (resolved.startsWith(`${path.resolve(resultDirectory)}${path.sep}`)) {
          await unlink(resolved).catch(() => {});
        }
      }
      await removeSessionState(dataRoot, sessionId);
      await rmdir(resultDirectory).catch(() => {});
    } else {
      await saveSessionState(dataRoot, sessionId, state);
    }
  });
}

async function main() {
  validateIdentifier(sessionId, "Session ID");
  validateIdentifier(jobId, "Job ID");
  if (!path.isAbsolute(dataRoot)) throw new Error("PLUGIN_DATA path must be absolute.");
  const specPath = path.join(dataRoot, "jobs", sessionId, `${jobId}.json`);
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  const request = spec.request;
  const abortController = new AbortController();
  const cancellationPoll = setInterval(async () => {
    try {
      const state = await loadSessionState(dataRoot, sessionId);
      if (!state.activeJob || state.activeJob.id !== jobId || state.activeJob.cancelRequested) {
        abortController.abort(new Error("Claude Code job cancelled."));
      }
    } catch {
      abortController.abort(new Error("Claude Code job state became unavailable."));
    }
  }, 250);
  cancellationPoll.unref?.();
  try {
    await mutateSession(async (state) => {
      if (state.activeJob?.id !== jobId) throw new Error("Claude Code job is no longer active.");
      state.activeJob.status = "running";
      state.activeJob.updatedAt = Date.now();
    });
    const mcpConfig = {
      mcpServers: {
        [PERMISSION_SERVER_NAME]: {
          type: "stdio",
          command: process.execPath,
          args: [PERMISSION_SERVER, dataRoot, sessionId, jobId],
        },
      },
    };
    const result = await runClaudeNative(request.input, {
      signal: abortController.signal,
      environment: process.env,
      permissionPromptToolName: PERMISSION_TOOL_NAME,
      mcpConfig,
      ...(request.input.customizationSources === "safe" ? {
        onPermission: (argumentsObject, options) => requestPermission(argumentsObject, { dataRoot, sessionId, jobId }, options),
      } : {}),
    });
    request.resultSessionId = result.session_id;
    request.responseText = result.result;
    await storeFinal(
      result.ok ? "completed" : "failed",
      formatClaudeJobResult(result, request),
      result.ok ? null : result.result,
      request,
    );
  } catch (error) {
    const cancelled = abortController.signal.aborted || error?.code === "CANCELLED";
    const message = error instanceof Error ? error.message : String(error);
    await storeFinal(cancelled ? "cancelled" : "failed", `Claude Code 任务${cancelled ? "已取消" : "失败"}：${message}`, message, request);
  } finally {
    clearInterval(cancellationPoll);
    await unlink(specPath).catch(() => {});
  }
}

main().catch(() => {
  process.exitCode = 1;
});
