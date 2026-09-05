import assert from "node:assert/strict";
import fsPromises, { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadCommandConfig, saveCommandConfig, withStateLock } from "../server/lib/state-store.mjs";

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
