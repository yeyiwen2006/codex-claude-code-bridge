import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  loadSessionState,
  saveSessionState,
  sessionLockName,
  withStateLock,
} from "./state-store.mjs";

const WORKER_PATH = fileURLToPath(new URL("./claude-job-worker.mjs", import.meta.url));
const EVENT_WAIT_MS = 30_000;
const POLL_MS = 150;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function activeStatus(job) {
  return job && ["starting", "running", "waiting"].includes(job.status);
}

async function mutateSession(dataRoot, sessionId, operation) {
  return withStateLock(dataRoot, sessionLockName(sessionId), async () => {
    const state = await loadSessionState(dataRoot, sessionId);
    const result = await operation(state);
    await saveSessionState(dataRoot, sessionId, state);
    return result;
  });
}

function jobDirectory(dataRoot, sessionId) {
  return path.join(dataRoot, "jobs", sessionId);
}

function jobSpecPath(dataRoot, sessionId, jobId) {
  return path.join(jobDirectory(dataRoot, sessionId), `${jobId}.json`);
}

function spawnWorker(dataRoot, sessionId, jobId, environment) {
  const child = spawn(process.execPath, [WORKER_PATH, dataRoot, sessionId, jobId], {
    cwd: process.cwd(),
    env: environment,
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

export function approvalText(job) {
  if (job.decision) {
    return `权限决定 ${job.decision.action} 已提交；Claude Code 任务 ${job.id} 正在从暂停处恢复。可用 /claude status 查看进度，或 /claude cancel ${job.id} 取消。`;
  }
  const pending = job.pendingApproval;
  if (!pending) {
    return `Claude Code 任务 ${job.id} 正在运行。可用 /claude status 查看进度，或 /claude cancel ${job.id} 取消。`;
  }
  const commands = pending.toolName === "AskUserQuestion"
    ? [
        `/claude answer ${pending.id} -- {"问题原文":"选项或回答"}`,
        `/claude deny ${pending.id} -- 不回答此问题`,
      ]
    : [
        `/claude allow ${pending.id} once`,
        `/claude allow ${pending.id} session`,
        `/claude allow ${pending.id} project`,
        `/claude deny ${pending.id} -- <原因>`,
      ];
  return [
    `Claude Code 已运行到一个真实的权限请求（任务 ${job.id}），原进程正在等待：`,
    `工具：${pending.toolName}`,
    pending.title ? `请求：${pending.title}` : null,
    pending.description ? `说明：${pending.description}` : null,
    pending.decisionReason ? `触发原因：${pending.decisionReason}` : null,
    pending.blockedPath ? `相关路径：${pending.blockedPath}` : null,
    "参数：",
    pending.inputText,
    "",
    "可执行：",
    ...commands,
  ].filter((entry) => entry !== null).join("\n");
}

async function consumeCompletedJob(dataRoot, sessionId, job) {
  let text = job.error ? `Claude Code 任务失败：${job.error}` : "Claude Code 已结束，但没有结果文本。";
  if (job.resultPath) {
    text = await readFile(job.resultPath, "utf8").catch(() => text);
  }
  await mutateSession(dataRoot, sessionId, async (state) => {
    if (state.activeJob?.id === job.id) {
      state.activeJob = null;
    }
  });
  return text;
}

export async function waitForJobEvent(dataRoot, sessionId, jobId, waitMs = EVENT_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  while (true) {
    const state = await loadSessionState(dataRoot, sessionId);
    const job = state.activeJob;
    if (!job || job.id !== jobId) {
      return "Claude Code 任务状态已不存在；它可能已被清理。";
    }
    if (job.status === "waiting" && !job.decision) {
      return approvalText(job);
    }
    if (["completed", "failed", "cancelled"].includes(job.status)) {
      return consumeCompletedJob(dataRoot, sessionId, job);
    }
    if (Date.now() >= deadline) {
      return approvalText(job);
    }
    await delay(POLL_MS);
  }
}

export async function startClaudeJob(request, context) {
  const jobId = randomUUID().replaceAll("-", "").slice(0, 8);
  const directory = jobDirectory(context.dataRoot, context.sessionId);
  const specPath = jobSpecPath(context.dataRoot, context.sessionId, jobId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(specPath, `${JSON.stringify({ request }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await mutateSession(context.dataRoot, context.sessionId, async (state) => {
      if (activeStatus(state.activeJob)) {
        throw new Error(`已有 Claude Code 任务 ${state.activeJob.id} 正在运行；请先处理、等待或取消它。`);
      }
      state.activeJob = {
        id: jobId,
        status: "starting",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        permissionMode: request.input.permissionMode,
        workerPid: null,
        pendingApproval: null,
        decision: null,
        cancelRequested: false,
        resultPath: null,
        error: null,
      };
    });
    const workerPid = spawnWorker(context.dataRoot, context.sessionId, jobId, context.environment);
    await mutateSession(context.dataRoot, context.sessionId, async (state) => {
      if (state.activeJob?.id === jobId) {
        state.activeJob.workerPid = workerPid;
        state.activeJob.updatedAt = Date.now();
      }
    });
  } catch (error) {
    await unlink(specPath).catch(() => {});
    throw error;
  }
  return waitForJobEvent(context.dataRoot, context.sessionId, jobId);
}

export async function describeClaudeJob(context) {
  const state = await loadSessionState(context.dataRoot, context.sessionId);
  const job = state.activeJob;
  if (!job) return "无";
  if (job.status === "waiting") return `等待审批 ${job.pendingApproval?.id ?? "?"}（任务 ${job.id}）`;
  if (["completed", "failed", "cancelled"].includes(job.status)) {
    return `${job.status}（任务 ${job.id}；发送 /claude result 读取结果）`;
  }
  return `${job.status}（任务 ${job.id}）`;
}

export async function readClaudeJobResult(context) {
  const state = await loadSessionState(context.dataRoot, context.sessionId);
  if (!state.activeJob) return "当前没有 Claude Code 任务。";
  if (["completed", "failed", "cancelled"].includes(state.activeJob.status)) {
    return consumeCompletedJob(context.dataRoot, context.sessionId, state.activeJob);
  }
  return approvalText(state.activeJob);
}

export async function resolveClaudeApproval(command, context) {
  const jobId = await mutateSession(context.dataRoot, context.sessionId, async (state) => {
    const job = state.activeJob;
    if (
      !job
      || job.status !== "waiting"
      || job.pendingApproval?.id !== command.approvalId
      || job.decision
    ) {
      throw new Error("没有找到该权限请求；它可能已处理、过期或不属于当前 Codex 会话。");
    }
    const isQuestion = job.pendingApproval.toolName === "AskUserQuestion";
    if (command.kind === "answer" && !isQuestion) {
      throw new Error("/claude answer 只能处理 AskUserQuestion；普通工具请求请使用 allow 或 deny。");
    }
    if (command.kind === "allow" && isQuestion) {
      throw new Error("AskUserQuestion 需要使用 /claude answer 提交回答，或使用 deny 拒绝。");
    }
    job.decision = {
      approvalId: command.approvalId,
      action: command.kind,
      scope: command.scope ?? "once",
      reason: command.reason ?? "用户拒绝了该工具调用。",
      answers: command.answers,
      createdAt: Date.now(),
    };
    job.updatedAt = Date.now();
    return job.id;
  });
  return waitForJobEvent(context.dataRoot, context.sessionId, jobId);
}

export async function cancelClaudeJob(command, context) {
  const jobId = await mutateSession(context.dataRoot, context.sessionId, async (state) => {
    const job = state.activeJob;
    if (!job || !activeStatus(job)) {
      throw new Error("当前没有正在运行的 Claude Code 任务。");
    }
    if (command.jobId && command.jobId !== job.id) {
      throw new Error(`当前运行的是任务 ${job.id}，不是 ${command.jobId}。`);
    }
    job.cancelRequested = true;
    job.updatedAt = Date.now();
    return job.id;
  });
  return waitForJobEvent(context.dataRoot, context.sessionId, jobId, 10_000);
}
