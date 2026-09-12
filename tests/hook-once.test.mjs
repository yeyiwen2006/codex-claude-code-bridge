import assert from "node:assert/strict";
import fsPromises, { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cleanupHookReceipts, runHookCommandOnce } from "../server/lib/hook-once.mjs";

const markerId = "00000000-0000-4000-8000-000000000001";

async function pending(dataRoot, sessionId, turnId, owner, lockOwner = owner, marker = markerId) {
  const directory = path.join(dataRoot, "state", "turn-receipts", sessionId);
  const markerPath = path.join(directory, `${turnId}.${marker}.pending`);
  const lockPath = path.join(dataRoot, "locks", `turn_${turnId}.lock`);
  await mkdir(directory, { recursive: true });
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(markerPath, `${owner}\n`, "utf8");
  if (lockOwner !== null) await writeFile(lockPath, `${lockOwner}\n`, "utf8");
  return { directory, markerPath, lockPath };
}

test("SessionEnd reclaims only its own confirmed dead turn locks and pending markers", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-dead-turn-lock-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const owner = 2147483647;
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === owner) throw Object.assign(new Error("exited test owner"), { code: "ESRCH" });
    return originalKill(pid, signal);
  };
  t.after(() => { process.kill = originalKill; });
  const own = await pending(dataRoot, "session-own-0001", "turn-own-0001", owner);
  const noLock = await pending(dataRoot, "session-own-0001", "turn-without-lock", owner, null);
  const other = await pending(dataRoot, "session-other-0001", "turn-other-0001", owner);
  await cleanupHookReceipts(dataRoot, "session-own-0001");
  for (const filename of [own.markerPath, own.lockPath, own.directory, noLock.markerPath, noLock.lockPath]) {
    await assert.rejects(access(filename), { code: "ENOENT" });
  }
  assert.equal((await readFile(other.lockPath, "utf8")).trim(), String(owner));
  await access(other.markerPath);
});

test("SessionEnd retains live, inaccessible, malformed, and replaced turn lock owners", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-preserve-turn-lock-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const originalKill = process.kill;
  const deadPid = 2147483647;
  const inaccessiblePid = 2147483646;
  process.kill = (pid, signal) => {
    if (pid === deadPid) throw Object.assign(new Error("exited test owner"), { code: "ESRCH" });
    if (pid === inaccessiblePid) throw Object.assign(new Error("inaccessible test owner"), { code: "EPERM" });
    return originalKill(pid, signal);
  };
  t.after(() => { process.kill = originalKill; });
  const sessionId = "session-conservative-0001";
  const cases = [
    await pending(dataRoot, sessionId, "turn-live-0001", process.pid),
    await pending(dataRoot, sessionId, "turn-eperm-0001", inaccessiblePid),
    await pending(dataRoot, sessionId, "turn-unknown-0001", "unknown"),
  ];
  const replaced = await pending(dataRoot, sessionId, "turn-replaced-0001", deadPid, process.pid);
  await cleanupHookReceipts(dataRoot, sessionId);
  for (const entry of cases) {
    await access(entry.markerPath);
    await access(entry.lockPath);
  }
  await access(replaced.lockPath);
  await assert.rejects(access(replaced.markerPath), { code: "ENOENT" });
});

test("dead duplicate markers are cleared regardless of their owner's position in the directory", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-dead-duplicate-markers-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const originalKill = process.kill;
  const owner = 2147483647;
  const waiter = 2147483646;
  process.kill = (pid, signal) => {
    if ([owner, waiter].includes(pid)) throw Object.assign(new Error("exited hook"), { code: "ESRCH" });
    return originalKill(pid, signal);
  };
  t.after(() => { process.kill = originalKill; });
  const sessionId = "session-dead-duplicates";
  const turnId = "turn-dead-duplicates";
  const earlierWaiter = await pending(dataRoot, sessionId, turnId, waiter, owner);
  await pending(dataRoot, sessionId, turnId, owner, owner, "00000000-0000-4000-8000-000000000002");
  const markerOrder = await readdir(earlierWaiter.directory);
  await writeFile(path.join(earlierWaiter.directory, markerOrder[0]), `${waiter}\n`, "utf8");
  await writeFile(path.join(earlierWaiter.directory, markerOrder[1]), `${owner}\n`, "utf8");
  await cleanupHookReceipts(dataRoot, sessionId);
  await assert.rejects(access(earlierWaiter.directory), { code: "ENOENT" });
  await assert.rejects(access(earlierWaiter.lockPath), { code: "ENOENT" });
});

test("a live hook retains its pending marker until normal completion and leaves no lock", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-live-turn-marker-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "session-live-operation";
  const turnId = "turn-live-operation";
  let release;
  let entered;
  const running = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const operation = runHookCommandOnce(dataRoot, sessionId, turnId, async () => { entered(); await gate; return "completed"; });
  await running;
  const directory = path.join(dataRoot, "state", "turn-receipts", sessionId);
  try {
    await cleanupHookReceipts(dataRoot, sessionId);
    assert.equal((await readdir(directory)).filter((name) => name.endsWith(".pending")).length, 1);
    await access(path.join(dataRoot, "locks", `turn_${turnId}.lock`));
  } finally {
    release();
    assert.equal(await operation, "completed");
  }
  assert.deepEqual(await readdir(directory), [`${turnId}.done`]);
  assert.deepEqual(await readdir(path.join(dataRoot, "locks")), []);
  await cleanupHookReceipts(dataRoot, sessionId);
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("cleanup rechecks a newly live lock owner and changed pending marker", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-turn-owner-recheck-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const originalKill = process.kill;
  const originalReadFile = fsPromises.readFile;
  const owner = 2147483647;
  process.kill = (pid, signal) => {
    if (pid === owner) throw Object.assign(new Error("exited hook"), { code: "ESRCH" });
    return originalKill(pid, signal);
  };
  t.after(() => { process.kill = originalKill; fsPromises.readFile = originalReadFile; syncBuiltinESMExports(); });
  for (const target of ["lockPath", "markerPath"]) {
    const sessionId = `session-recheck-${target}`;
    const item = await pending(dataRoot, sessionId, `turn-recheck-${target}`, owner);
    let replaced = false;
    fsPromises.readFile = async (filename, ...args) => {
      const text = await originalReadFile(filename, ...args);
      if (filename === item[target] && !replaced) {
        replaced = true;
        await writeFile(filename, `${process.pid}\n`, "utf8");
      }
      return text;
    };
    syncBuiltinESMExports();
    try { await cleanupHookReceipts(dataRoot, sessionId); } finally {
      fsPromises.readFile = originalReadFile;
      syncBuiltinESMExports();
    }
    assert.equal(replaced, true);
    assert.equal((await readFile(item[target], "utf8")).trim(), String(process.pid));
    await access(item.markerPath);
  }
});
