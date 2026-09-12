import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addClipboardImages,
  clearQueuedImages,
} from "../server/lib/image-queue.mjs";
import { InputError } from "../server/lib/validation.mjs";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let temporaryRoot;

before(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-claude-code-bridge-images-"));
});

after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

test("rejects a repeated clipboard sequence without hashes and removes the duplicate capture", async () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const state = { images: [], lastClipboardSequence: null };
  let call = 0;
  let duplicatePath;
  const captureFunction = async (destination) => {
    call += 1;
    await mkdir(destination, { recursive: true });
    const filePath = path.join(destination, `call-${call}.png`);
    await writeFile(filePath, PNG_1X1);
    if (call === 2) duplicatePath = filePath;
    return {
      clipboardSequence: "42",
      items: [{
        path: filePath,
        sourceName: `call-${call}.png`,
        sourceFormat: "test",
        byteExact: true,
      }],
    };
  };

  const first = await addClipboardImages(state, temporaryRoot, sessionId, { captureFunction });
  assert.equal(first.length, 1);
  assert.equal(state.images.length, 1);

  await assert.rejects(
    addClipboardImages(state, temporaryRoot, sessionId, { captureFunction }),
    (error) => error instanceof InputError && /序列号|相同/.test(error.message),
  );
  await assert.rejects(access(duplicatePath));
  assert.equal(state.images.length, 1);

  const originalPath = state.images[0].storedPath;
  assert.equal(await clearQueuedImages(state, temporaryRoot, sessionId), 1);
  await assert.rejects(access(originalPath));
});

test("rejects non-image clipboard bytes", async () => {
  const sessionId = "aaaaaaaa-2222-4333-8444-bbbbbbbbbbbb";
  const state = { images: [], lastClipboardSequence: null };
  let invalidPath;
  const captureFunction = async (destination) => {
    await mkdir(destination, { recursive: true });
    invalidPath = path.join(destination, "not-an-image.png");
    await writeFile(invalidPath, "not an image", "utf8");
    return {
      clipboardSequence: "99",
      items: [{
        path: invalidPath,
        sourceName: "not-an-image.png",
        sourceFormat: "test",
        byteExact: true,
      }],
    };
  };

  await assert.rejects(
    addClipboardImages(state, temporaryRoot, sessionId, { captureFunction }),
    (error) => error instanceof InputError && /supported PNG/.test(error.message),
  );
  await assert.rejects(access(invalidPath));
  assert.equal(state.images.length, 0);
});

test("clears canonical image paths when the data root is a filesystem alias", async () => {
  const canonicalRoot = path.join(temporaryRoot, "canonical-root");
  const aliasRoot = path.join(temporaryRoot, "alias-root");
  await mkdir(canonicalRoot, { recursive: true });
  await symlink(canonicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  const sessionId = "cccccccc-2222-4333-8444-dddddddddddd";
  const state = { images: [], lastClipboardSequence: null };
  const captureFunction = async (destination) => {
    await mkdir(destination, { recursive: true });
    const filePath = path.join(destination, "aliased.png");
    await writeFile(filePath, PNG_1X1);
    return {
      clipboardSequence: "100",
      items: [{
        path: filePath,
        sourceName: "aliased.png",
        sourceFormat: "test",
        byteExact: true,
      }],
    };
  };

  await addClipboardImages(state, aliasRoot, sessionId, { captureFunction });
  const storedPath = state.images[0].storedPath;
  assert.equal(await clearQueuedImages(state, aliasRoot, sessionId), 1);
  await assert.rejects(access(storedPath));
  assert.equal(state.images.length, 0);

  let invalidPath;
  const invalidCaptureFunction = async (destination) => {
    await mkdir(destination, { recursive: true });
    invalidPath = path.join(destination, "invalid.png");
    await writeFile(invalidPath, "not an image", "utf8");
    return {
      clipboardSequence: "101",
      items: [{
        path: invalidPath,
        sourceName: "invalid.png",
        sourceFormat: "test",
        byteExact: true,
      }],
    };
  };
  await assert.rejects(
    addClipboardImages(state, aliasRoot, sessionId, { captureFunction: invalidCaptureFunction }),
    (error) => error instanceof InputError && /supported PNG/.test(error.message),
  );
  await assert.rejects(access(invalidPath));
});

test("refuses to clear queued images through a redirected parent directory", async () => {
  const sessionId = "redirected-image-session";
  const state = { images: [], lastClipboardSequence: null };
  let capturedDirectory;
  await addClipboardImages(state, temporaryRoot, sessionId, {
    captureFunction: async (destination) => {
      capturedDirectory = path.join(destination, "batch");
      await mkdir(capturedDirectory, { recursive: true });
      const filePath = path.join(capturedDirectory, "image.png");
      await writeFile(filePath, PNG_1X1);
      return { clipboardSequence: "102", items: [{ path: filePath }] };
    },
  });
  const outside = path.join(temporaryRoot, "outside-queue");
  await mkdir(outside);
  const outsideImage = path.join(outside, "image.png");
  await writeFile(outsideImage, "unrelated original", "utf8");
  await rename(capturedDirectory, `${capturedDirectory}-original`);
  await symlink(outside, capturedDirectory, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(clearQueuedImages(state, temporaryRoot, sessionId), /outside the private session queue/);
  assert.equal(await readFile(outsideImage, "utf8"), "unrelated original");
  assert.equal(state.images.length, 1);
});

test("cleans an interrupted capture batch while preserving already queued images", async () => {
  const sessionId = "failed-capture-session";
  const state = { images: [], lastClipboardSequence: null };
  const [queued] = await addClipboardImages(state, temporaryRoot, sessionId, {
    captureFunction: async (destination) => {
      const filePath = path.join(destination, "original.png");
      await writeFile(filePath, PNG_1X1);
      return { clipboardSequence: "103", items: [{ path: filePath }] };
    },
  });
  let failedBatch;
  await assert.rejects(addClipboardImages(state, temporaryRoot, sessionId, {
    captureFunction: async (destination) => {
      failedBatch = destination;
      await writeFile(path.join(destination, "partial.png"), PNG_1X1);
      throw new Error("Clipboard helper exited before producing JSON");
    },
  }), /before producing JSON/);
  await assert.rejects(access(failedBatch));
  assert.deepEqual(await readFile(queued.storedPath), PNG_1X1);
  assert.equal(state.images.length, 1);
  assert.equal(state.lastClipboardSequence, "103");
  await clearQueuedImages(state, temporaryRoot, sessionId);
  await assert.rejects(access(path.join(temporaryRoot, "images", sessionId)));
});

test("rejects capture and clearing when an image root redirects outside plugin data", async () => {
  for (const level of ["session", "images"]) {
    const dataRoot = path.join(temporaryRoot, `redirected-${level}-data`);
    const outside = path.join(temporaryRoot, `redirected-${level}-outside`);
    const sessionId = "redirected-root-session";
    await mkdir(dataRoot);
    await mkdir(outside);
    const externalSession = level === "session" ? outside : path.join(outside, sessionId);
    await mkdir(externalSession, { recursive: true });
    const imagesRoot = path.join(dataRoot, "images");
    if (level === "session") await mkdir(imagesRoot);
    await symlink(outside, level === "session" ? path.join(imagesRoot, sessionId) : imagesRoot,
      process.platform === "win32" ? "junction" : "dir");
    const original = path.join(externalSession, "original.png");
    await writeFile(original, PNG_1X1);
    const state = { images: [{ id: "outside-image", storedPath: original }], lastClipboardSequence: null };
    await assert.rejects(clearQueuedImages(state, dataRoot, sessionId), /outside the plugin data directory/);
    let captured = false;
    await assert.rejects(addClipboardImages(state, dataRoot, sessionId, {
      captureFunction: async () => { captured = true; throw new Error("capture should not run"); },
    }), /outside the plugin data directory/);
    assert.equal(captured, false);
    assert.deepEqual(await readFile(original), PNG_1X1);
    assert.equal(state.images.length, 1);
  }
});

test("failed capture cleanup refuses a session root redirected outside plugin data", async () => {
  const dataRoot = path.join(temporaryRoot, "cleanup-redirect-data");
  const outside = path.join(temporaryRoot, "cleanup-redirect-outside");
  await mkdir(dataRoot);
  await mkdir(outside);
  let original;
  await assert.rejects(addClipboardImages({ images: [], lastClipboardSequence: null }, dataRoot,
    "cleanup-redirect-session", {
      captureFunction: async (destination) => {
        const externalBatch = path.join(outside, path.basename(destination));
        await mkdir(externalBatch);
        original = path.join(externalBatch, "original.png");
        await writeFile(original, PNG_1X1);
        const sessionDirectory = path.dirname(destination);
        await rename(sessionDirectory, `${sessionDirectory}-original`);
        await symlink(outside, sessionDirectory, process.platform === "win32" ? "junction" : "dir");
        throw new Error("capture interrupted after directory replacement");
      },
    }), /capture interrupted/);
  assert.deepEqual(await readFile(original), PNG_1X1);
});
