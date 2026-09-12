import {
  mkdir,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { InputError } from "./validation.mjs";
import { parseLockOwnerPid, withStateLock } from "./state-store.mjs";

const TURN_LOCK_WAIT_MS = 3_640_000;

function validateHookIdentifier(value, label, maximumLength = 100) {
  if (
    typeof value !== "string"
    || value.length > maximumLength
    || !/^[A-Za-z0-9_-]{8,128}$/.test(value)
  ) {
    throw new InputError(`${label} contains unsupported characters.`);
  }
  return value;
}

function receiptDirectory(dataRoot, sessionId) {
  return path.join(
    dataRoot,
    "state",
    "turn-receipts",
    validateHookIdentifier(sessionId, "Session ID", 128),
  );
}

function receiptPath(dataRoot, sessionId, turnId) {
  return path.join(
    receiptDirectory(dataRoot, sessionId),
    `${validateHookIdentifier(turnId, "Turn ID")}.done`,
  );
}

async function receiptExists(filePath) {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function runHookCommandOnce(dataRoot, sessionId, turnId, operation) {
  if (turnId === undefined || turnId === null) {
    return operation();
  }
  const normalizedTurnId = validateHookIdentifier(turnId, "Turn ID");
  const filePath = receiptPath(dataRoot, sessionId, normalizedTurnId);
  // Record session ownership before acquiring the global turn lock. A unique
  // marker also distinguishes duplicate hook processes waiting on one turn.
  const pendingPath = path.join(path.dirname(filePath), `${normalizedTurnId}.${randomUUID()}.pending`);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(pendingPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return await withStateLock(dataRoot, `turn_${normalizedTurnId}`, async () => {
      if (await receiptExists(filePath)) {
        return null;
      }
      const output = await operation();
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFile(filePath, `${Date.now()}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      }).catch((error) => {
        if (!(error && typeof error === "object" && error.code === "EEXIST")) {
          throw error;
        }
      });
      return output;
    }, { waitMs: TURN_LOCK_WAIT_MS });
  } finally {
    await unlink(pendingPath).catch(() => {});
  }
}

async function cleanupDeadTurnLock(dataRoot, markerPath, turnId) {
  let ownerText;
  try { ownerText = await readFile(markerPath, "utf8"); } catch { return; }
  const ownerPid = Number(ownerText.trim());
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return;
  try { process.kill(ownerPid, 0); return; } catch (error) { if (error?.code !== "ESRCH") return; }
  const lockName = `turn_${turnId}`;
  try {
    const currentOwner = await readFile(path.join(dataRoot, "locks", `${lockName}.lock`), "utf8");
    if (parseLockOwnerPid(currentOwner) !== ownerPid) {
      // A dead duplicate may have waited behind another hook. Its unique
      // session marker is obsolete even when the other hook retains the lock.
      // Never acquire, remove, or change that other owner's lock here.
      if (await readFile(markerPath, "utf8").catch(() => null) === ownerText) await unlink(markerPath);
      return;
    }
  } catch (error) { if (error?.code !== "ENOENT") return; }
  // Reuse normal lock acquisition with no wait. If it observes a new live
  // owner, leave that lock and this marker for a later cleanup attempt.
  await withStateLock(dataRoot, lockName, async () => {
    if (await readFile(markerPath, "utf8").catch(() => null) === ownerText) {
      await unlink(markerPath);
    }
  }, { waitMs: 0 }).catch(() => {});
}

export async function cleanupHookReceipts(dataRoot, sessionId) {
  const directory = receiptDirectory(dataRoot, sessionId);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && /^[A-Za-z0-9_-]{8,100}\.done$/.test(entry.name)) {
      await unlink(path.join(directory, entry.name));
    } else if (entry.isFile()) {
      const pending = /^([A-Za-z0-9_-]{8,100})\.[A-Za-z0-9_-]{36}\.pending$/.exec(entry.name);
      if (pending) await cleanupDeadTurnLock(dataRoot, path.join(directory, entry.name), pending[1]);
    }
  }
  await rmdir(directory).catch((error) => {
    if (!(error && typeof error === "object" && ["ENOENT", "ENOTEMPTY"].includes(error.code))) {
      throw error;
    }
  });
}
