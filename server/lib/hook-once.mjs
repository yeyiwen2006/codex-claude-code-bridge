import {
  mkdir,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { InputError } from "./validation.mjs";
import { withStateLock } from "./state-store.mjs";

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
  return withStateLock(dataRoot, `turn_${normalizedTurnId}`, async () => {
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
    }
  }
  await rmdir(directory).catch((error) => {
    if (!(error && typeof error === "object" && ["ENOENT", "ENOTEMPTY"].includes(error.code))) {
      throw error;
    }
  });
}
