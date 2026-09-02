import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
