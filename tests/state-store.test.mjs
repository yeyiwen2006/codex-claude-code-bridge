import assert from "node:assert/strict";
import fsPromises, { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadCommandConfig, loadSessionState, saveCommandConfig, saveSessionState, sessionLockName, withStateLock } from "../server/lib/state-store.mjs";

test("locks and saves a session with the maximum supported identifier length", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-long-session-lock-"));
  const sessionId = "a".repeat(128);
  try {
    await withStateLock(dataRoot, sessionLockName(sessionId), async () => {
      await saveSessionState(dataRoot, sessionId, { claudeSessionId: "fixture-session" });
    });
    assert.equal((await loadSessionState(dataRoot, sessionId)).claudeSessionId, "fixture-session");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("keeps the previous state readable while retrying a busy file replacement", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-state-replace-"));
  const originalRename = fsPromises.rename;
  try {
    for (const code of ["EPERM", "EEXIST", "EBUSY"]) {
      await saveCommandConfig(dataRoot, { model: "opus" });
      let attempts = 0;
      fsPromises.rename = async (...args) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("Simulated busy destination"), { code });
        assert.equal((await loadCommandConfig(dataRoot)).model, "opus", "readers must retain the old state until replacement succeeds");
        return originalRename(...args);
      };
      syncBuiltinESMExports();
      try {
        await saveCommandConfig(dataRoot, { model: "sonnet" });
        assert.equal(attempts, 2);
        assert.equal((await loadCommandConfig(dataRoot)).model, "sonnet");
      } finally {
        fsPromises.rename = originalRename;
        syncBuiltinESMExports();
      }
    }
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("reclaims a lock immediately when its owner process no longer exists", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-claude-code-bridge-lock-"));
  try {
    const lockDirectory = path.join(dataRoot, "locks");
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, "dead_owner.lock"), "2147483647\n", "utf8");

    const startedAt = Date.now();
    const result = await withStateLock(dataRoot, "dead_owner", async () => "recovered");
    assert.equal(result, "recovered");
    assert.ok(Date.now() - startedAt < 1_000, "dead lock recovery should not wait for the normal lock timeout");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("waits for a lock owned by a running process instead of reclaiming it", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-claude-code-bridge-lock-"));
  try {
    const lockDirectory = path.join(dataRoot, "locks");
    const lockPath = path.join(lockDirectory, "live_owner.lock");
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(lockPath, `${process.pid}\n`, "utf8");
    const release = setTimeout(() => void unlink(lockPath).catch(() => {}), 150);

    const startedAt = Date.now();
    const result = await withStateLock(dataRoot, "live_owner", async () => "acquired-after-release");
    clearTimeout(release);
    assert.equal(result, "acquired-after-release");
    assert.ok(Date.now() - startedAt >= 100, "a lock owned by a running process must not be reclaimed early");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("serializes competing lock owners through repeated release and acquisition", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-lock-contention-"));
  try {
    let active = 0;
    let completed = 0;
    for (let round = 0; round < 3; round += 1) {
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => withStateLock(dataRoot, "contended_lock", async () => {
        active += 1;
        try {
          assert.equal(active, 1, "lock owners must never overlap");
          await new Promise((resolve) => setTimeout(resolve, 4));
          completed += 1;
        } finally {
          active -= 1;
        }
      })));
      // Wait for every contender before cleaning up, including after a failure.
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
    }
    assert.equal(completed, 36);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("old age cannot reclaim a live, inaccessible or unidentifiable lock owner", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-aged-live-lock-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const lockDirectory = path.join(dataRoot, "locks");
  await mkdir(lockDirectory, { recursive: true });
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === 2147483646) throw Object.assign(new Error("inaccessible fixture"), { code: "EPERM" });
    return originalKill(pid, signal);
  };
  t.after(() => { process.kill = originalKill; });
  for (const [name, owner] of [["old_live", process.pid], ["old_inaccessible", 2147483646], ["old_unknown", "unknown"]]) {
    const lockPath = path.join(lockDirectory, `${name}.lock`);
    const text = `${owner}\n`;
    await writeFile(lockPath, text, "utf8");
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(lockPath, old, old);
    await assert.rejects(withStateLock(dataRoot, name, async () => assert.fail("must not steal a lock"), { waitMs: 0 }), /Another.*command is updating local state/);
    assert.equal(await readFile(lockPath, "utf8"), text);
  }
});

test("two reclaimers with the same old observation cannot delete the new owner's lock", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-recovery-generation-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const lockPath = path.join(dataRoot, "locks", "contended_dead.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, "2147483647\n", "utf8");
  const originalLink = fsPromises.link;
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === 2147483647) throw Object.assign(new Error("exited owner"), { code: "ESRCH" });
    return originalKill(pid, signal);
  };
  let firstObserved;
  let secondObserved;
  let firstEntered;
  let release;
  const firstObservation = new Promise((resolve) => { firstObserved = resolve; });
  const bothObserved = new Promise((resolve) => { secondObserved = resolve; });
  const holdingLock = new Promise((resolve) => { firstEntered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let claims = 0;
  fsPromises.link = async (...args) => {
    claims += 1;
    if (claims === 1) { firstObserved(); await bothObserved; }
    else if (claims === 2) { secondObserved(); await holdingLock; }
    return originalLink(...args);
  };
  syncBuiltinESMExports();
  const first = withStateLock(dataRoot, "contended_dead", async () => { firstEntered(); await gate; return "first"; });
  const firstOutcome = first.then((value) => ({ value }), (error) => ({ error }));
  let second;
  const boundedBarrier = async (barrier) => {
    let timer;
    try {
      await Promise.race([barrier, firstOutcome.then(({ error }) => { throw error ?? new Error("first owner finished before the barrier"); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("reclaimers did not reach the controlled barrier")), 3000); })]);
    } finally { clearTimeout(timer); }
  };
  try {
    // Establish the first observer before starting its competitor, independent
    // of filesystem scheduling. Neither can reclaim until both have observed.
    await boundedBarrier(firstObservation);
    second = withStateLock(dataRoot, "contended_dead", async () => assert.fail("the delayed reclaimer stole the new lock"), { waitMs: 150 })
      .then(() => null, (error) => error);
    await boundedBarrier(holdingLock);
    const newLockText = await readFile(lockPath, "utf8");
    const result = await second;
    assert.match(result?.message ?? "", /Another.*command is updating local state/);
    assert.equal(await readFile(lockPath, "utf8"), newLockText);
    assert.equal(claims, 2, "both reclaimers observed the same dead generation before one obtained the new lock");
  } finally {
    release();
    firstObserved();
    secondObserved();
    firstEntered();
    fsPromises.link = originalLink;
    process.kill = originalKill;
    syncBuiltinESMExports();
    await Promise.allSettled([firstOutcome, second]);
  }
  assert.equal(await first, "first");
});

test("a dead recovery claim is succeeded without taking a live recovery claim", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-recovery-claim-owner-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const originalKill = process.kill;
  const deadPid = 2147483647;
  process.kill = (pid, signal) => {
    if (pid === deadPid) throw Object.assign(new Error("exited owner"), { code: "ESRCH" });
    return originalKill(pid, signal);
  };
  t.after(() => { process.kill = originalKill; });
  const directory = path.join(dataRoot, "locks", "recovery");
  await mkdir(directory, { recursive: true });
  for (const [suffix, ownerPid] of [["dead", deadPid], ["live", process.pid]]) {
    const token = suffix === "dead" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002";
    const nextToken = "00000000-0000-4000-8000-000000000003";
    const lockPath = path.join(dataRoot, "locks", `claim_${suffix}.lock`);
    const claimPath = path.join(directory, `${token}.claim`);
    await mkdir(directory, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: deadPid, token }), "utf8");
    await writeFile(claimPath, JSON.stringify({ pid: ownerPid, token: nextToken }), "utf8");
    if (suffix === "dead") {
      assert.equal(await withStateLock(dataRoot, `claim_${suffix}`, async () => "recovered"), "recovered");
      await assert.rejects(readFile(claimPath), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(directory, `${nextToken}.claim`)), { code: "ENOENT" });
    } else {
      const before = await readFile(lockPath, "utf8");
      await assert.rejects(withStateLock(dataRoot, `claim_${suffix}`, async () => assert.fail("must retain a live reclaimer"), { waitMs: 0 }), /Another.*command is updating local state/);
      assert.equal(await readFile(lockPath, "utf8"), before);
      assert.equal(JSON.parse(await readFile(claimPath, "utf8")).pid, process.pid);
    }
  }
});

test("a failed recovery keeps the dead ancestor claim until its lock generation is removed", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-recovery-failed-unlink-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const originalKill = process.kill;
  const originalUnlink = fsPromises.unlink;
  const owner = 2147483647;
  process.kill = (pid, signal) => {
    if (pid === owner) throw Object.assign(new Error("exited owner"), { code: "ESRCH" });
    return originalKill(pid, signal);
  };
  t.after(() => { process.kill = originalKill; fsPromises.unlink = originalUnlink; syncBuiltinESMExports(); });
  const token = "00000000-0000-4000-8000-000000000011";
  const nextToken = "00000000-0000-4000-8000-000000000012";
  const directory = path.join(dataRoot, "locks", "recovery");
  const lockPath = path.join(dataRoot, "locks", "failed_recovery.lock");
  const claimPath = path.join(directory, `${token}.claim`);
  await mkdir(directory, { recursive: true });
  const originalLock = JSON.stringify({ pid: owner, token });
  await writeFile(lockPath, originalLock, "utf8");
  await writeFile(claimPath, JSON.stringify({ pid: owner, token: nextToken }), "utf8");
  fsPromises.unlink = async (filename) => {
    if (filename === lockPath) throw Object.assign(new Error("controlled unlink failure"), { code: "EACCES" });
    return originalUnlink(filename);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(withStateLock(dataRoot, "failed_recovery", async () => assert.fail("recovery must fail"), { waitMs: 0 }), { code: "EACCES" });
  } finally { fsPromises.unlink = originalUnlink; syncBuiltinESMExports(); }
  assert.equal(await readFile(lockPath, "utf8"), originalLock);
  assert.equal(JSON.parse(await readFile(claimPath, "utf8")).token, nextToken);
  await assert.rejects(readFile(path.join(directory, `${nextToken}.claim`)), { code: "ENOENT" });
  assert.equal(await withStateLock(dataRoot, "failed_recovery", async () => "recovered"), "recovered");
  await assert.rejects(readFile(claimPath), { code: "ENOENT" });
});
