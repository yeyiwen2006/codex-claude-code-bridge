import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InputError } from "./validation.mjs";

export const DEFAULT_COMMAND_CONFIG = Object.freeze({
  model: null,
  effort: null,
  permission: "manual",
  customizations: "all",
  timeoutSeconds: 1800,
  maxBudgetUsd: null,
  persistSession: false,
  conversationContext: true,
  pluginDirectories: [],
});

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function resolvePluginData(environment = process.env) {
  const configured = environment.PLUGIN_DATA;
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new InputError("PLUGIN_DATA must be an absolute path.");
    }
    return path.resolve(configured);
  }
  return path.join(os.tmpdir(), "codex-claude-code-bridge-development-data");
}

function validateIdentifier(identifier, label) {
  if (typeof identifier !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(identifier)) {
    throw new InputError(`${label} contains unsupported characters.`);
  }
  return identifier;
}

export function defaultSessionState() {
  return {
    version: 1,
    authorization: null,
    images: [],
    lastClipboardSequence: null,
    activeJob: null,
    sessionPermission: null,
    sessionEnded: false,
    claudeSessionId: null,
    claudeSessionRoot: null,
    forkNext: false,
    resultFiles: [],
    bridgeHistory: [],
    bridgeHistoryDelivered: [],
  };
}

async function ensureDataDirectories(dataRoot) {
  await Promise.all([
    mkdir(path.join(dataRoot, "state", "sessions"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(dataRoot, "locks"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(dataRoot, "images"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(dataRoot, "results"), { recursive: true, mode: 0o700 }),
  ]);
}

async function readJsonFile(filePath, fallback) {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return clone(fallback);
    }
    throw error;
  }
  let parsed;
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_STATE_BYTES) {
      throw new InputError(`Bridge state file is invalid: ${filePath}`);
    }
    try {
      // Keep the same file open across validation and reading. SessionEnd may
      // remove the path in between, which is not a malformed state file.
      parsed = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      throw new InputError(`Bridge state file cannot be parsed: ${error.message}`);
    }
  } finally {
    await handle.close();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InputError("Bridge state must contain a JSON object.");
  }
  return parsed;
}

async function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) {
    throw new InputError("Bridge state exceeds the local size limit.");
  }
  await writeFile(temporaryPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    const deadline = Date.now() + 1_000;
    while (true) {
      try {
        await rename(temporaryPath, filePath);
        break;
      } catch (error) {
        // Windows readers can briefly prevent replacement. Keep the old file:
        // deleting it first makes concurrent readers mistake the gap for cleanup.
        if (!["EEXIST", "EPERM", "EBUSY"].includes(error?.code) || Date.now() >= deadline) {
          throw error;
        }
        await delay(25);
      }
    }
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function lockOwnerIsRunning(lockPath) {
  let ownerText;
  try {
    ownerText = await readFile(lockPath, "utf8");
  } catch {
    // A disappearing lock means its owner released it. Treat that as a retry,
    // not a dead owner: unlinking here could remove a new owner's lock.
    return true;
  }
  const ownerPid = Number(ownerText.trim());
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    return true;
  }
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && error.code === "ESRCH");
  }
}

async function acquireLock(dataRoot, name, options = {}) {
  validateIdentifier(name, "Lock name");
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
    throw new InputError("Lock wait time must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(staleMs) || staleMs <= 0) {
    throw new InputError("Lock stale time must be a positive integer.");
  }
  await ensureDataDirectories(dataRoot);
  const lockPath = path.join(dataRoot, "locks", `${name}.lock`);
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return { handle, lockPath };
    } catch (error) {
      // Windows can report EPERM while another handle is finishing deletion of
      // the lock. Retry acquisition within the same deadline without unlinking it.
      if (process.platform === "win32" && error?.code === "EPERM" && Date.now() < deadline) {
        await delay(50);
        continue;
      }
      if (!(error && typeof error === "object" && error.code === "EEXIST")) {
        throw error;
      }
      try {
        const details = await stat(lockPath);
        if (Date.now() - details.mtimeMs > staleMs || !(await lockOwnerIsRunning(lockPath))) {
          await unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError && typeof statError === "object" && statError.code === "ENOENT") {
          continue;
        }
        if (process.platform === "win32" && statError?.code === "EPERM" && Date.now() < deadline) {
          await delay(50);
          continue;
        }
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new InputError("Another Codex Claude Code Bridge command is updating local state; retry shortly.");
      }
      await delay(50);
    }
  }
}

export async function withStateLock(dataRoot, name, operation, options = {}) {
  const lock = await acquireLock(dataRoot, name, options);
  try {
    return await operation();
  } finally {
    await lock.handle.close().catch(() => {});
    await unlink(lock.lockPath).catch(() => {});
  }
}

export async function loadCommandConfig(dataRoot) {
  await ensureDataDirectories(dataRoot);
  const stored = await readJsonFile(
    path.join(dataRoot, "state", "config.json"),
    DEFAULT_COMMAND_CONFIG,
  );
  return { ...clone(DEFAULT_COMMAND_CONFIG), ...stored };
}

export async function saveCommandConfig(dataRoot, config) {
  await ensureDataDirectories(dataRoot);
  await atomicWriteJson(path.join(dataRoot, "state", "config.json"), config);
}

export async function loadSessionState(dataRoot, sessionId) {
  const normalizedId = validateIdentifier(sessionId, "Session ID");
  await ensureDataDirectories(dataRoot);
  const stored = await readJsonFile(
    path.join(dataRoot, "state", "sessions", `${normalizedId}.json`),
    defaultSessionState(),
  );
  return { ...defaultSessionState(), ...stored };
}

export async function saveSessionState(dataRoot, sessionId, state) {
  const normalizedId = validateIdentifier(sessionId, "Session ID");
  await ensureDataDirectories(dataRoot);
  await atomicWriteJson(
    path.join(dataRoot, "state", "sessions", `${normalizedId}.json`),
    state,
  );
}

export async function removeSessionState(dataRoot, sessionId) {
  const normalizedId = validateIdentifier(sessionId, "Session ID");
  await unlink(path.join(dataRoot, "state", "sessions", `${normalizedId}.json`)).catch((error) => {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  });
}

export function sessionLockName(sessionId) {
  return `session_${validateIdentifier(sessionId, "Session ID")}`;
}
