import { randomUUID } from "node:crypto";
import {
  mkdir,
  link,
  open,
  readFile,
  rename,
  rmdir,
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

function validateIdentifier(identifier, label, maximumLength = 128) {
  if (typeof identifier !== "string" || !/^[A-Za-z0-9_-]{8,}$/.test(identifier)
    || identifier.length > maximumLength) {
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

export function parseLockOwnerPid(ownerText) {
  let record;
  try { record = JSON.parse(ownerText); } catch { return null; }
  const pid = typeof record === "number" ? record : record?.pid;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function ownerIsDefinitelyGone(ownerPid) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function readLockRecord(lockPath) {
  let handle;
  try {
    handle = await open(lockPath, "r");
    const details = await handle.stat();
    if (!details.isFile() || details.size > 2048) return null;
    const text = await handle.readFile("utf8");
    const pid = parseLockOwnerPid(text);
    if (!pid) return null;
    const record = JSON.parse(text);
    const token = typeof record?.token === "string" && /^[a-f0-9-]{36}$/.test(record.token) ? record.token : null;
    // Legacy PID-only files use metadata from the same open handle. New files
    // always have a random generation token; no file content is hashed.
    const identity = `${details.dev}_${details.ino}_${details.birthtimeMs}_${details.mtimeMs}`;
    return { text, pid, token, identity, generation: token ?? `legacy_${identity}_${pid}` };
  } catch (error) { return error?.code === "ENOENT" ? { missing: true } : null; } finally { await handle?.close().catch(() => {}); }
}

function sameLockRecord(left, right) {
  return left && right && left.text === right.text && left.identity === right.identity;
}

async function publishRecoveryClaim(directory, claimPath) {
  const prepared = path.join(directory, `${randomUUID()}.prepared`);
  try {
    await writeFile(prepared, `${JSON.stringify({ pid: process.pid, token: randomUUID() })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // link publishes complete metadata only if the destination does not exist.
    // Unlike rename, it cannot overwrite a claim held by another reclaimer.
    await link(prepared, claimPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally { await unlink(prepared).catch(() => {}); }
}

async function reclaimDeadLock(dataRoot, lockPath) {
  const observed = await readLockRecord(lockPath);
  if (!observed || !ownerIsDefinitelyGone(observed.pid)) return false;
  const directory = path.join(dataRoot, "locks", "recovery");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let claimId = observed.generation;
  const deadClaims = [];
  // A recovery process can itself crash. Compete for a successor named by that
  // dead claim's unique token; never delete an old claim to steal its slot.
  for (let depth = 0; depth < 32; depth += 1) {
    const claimPath = path.join(directory, `${claimId}.claim`);
    if (await publishRecoveryClaim(directory, claimPath)) {
      let generationObsolete = false;
      try {
        const current = await readLockRecord(lockPath);
        if (!sameLockRecord(current, observed)) {
          generationObsolete = current?.missing === true || Boolean(current?.pid);
          return false;
        }
        if (!ownerIsDefinitelyGone(current.pid)) return false;
        // All reclaimers for this generation share the claim chain. A delayed
        // contender must re-read the generation after it obtains its own claim.
        await unlink(lockPath);
        generationObsolete = true;
        return true;
      } finally {
        // Retain ancestors if the old generation still exists or is unknown.
        // Removing one then would let a new claimant reuse the ancestor slot
        // while a delayed contender still follows its successor.
        if (generationObsolete) {
          for (const deadClaim of deadClaims) await unlink(deadClaim).catch(() => {});
        }
        await unlink(claimPath).catch(() => {});
        await rmdir(directory).catch(() => {});
      }
    }
    const owner = await readLockRecord(claimPath);
    if (!owner) return false;
    if (!ownerIsDefinitelyGone(owner.pid) || !owner.token) return false;
    deadClaims.push(claimPath);
    claimId = owner.token;
  }
  return false;
}

async function acquireLock(dataRoot, name, options = {}) {
  // Session locks add "session_" to the already validated session identifier.
  validateIdentifier(name, "Lock name", 136);
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
    throw new InputError("Lock wait time must be a non-negative integer.");
  }
  await ensureDataDirectories(dataRoot);
  const lockPath = path.join(dataRoot, "locks", `${name}.lock`);
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token: randomUUID() })}\n`, "utf8");
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
        // Age does not prove a lock is abandoned: long-running commands and
        // inaccessible/reused PIDs must retain their locks.
        if (await reclaimDeadLock(dataRoot, lockPath)) continue;
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
