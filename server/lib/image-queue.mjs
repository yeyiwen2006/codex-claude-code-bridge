import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeProcess } from "./claude-runner.mjs";
import { InputError, pathIsWithinRoot } from "./validation.mjs";

const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const CAPTURE_SCRIPT = fileURLToPath(new URL("../../scripts/capture-clipboard.ps1", import.meta.url));

function sessionImageDirectory(dataRoot, sessionId) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) {
    throw new InputError("Session ID contains unsupported characters.");
  }
  return path.join(dataRoot, "images", sessionId);
}

function windowsPowerShellPath(environment) {
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readMagic(filePath) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function identifyImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mediaType: "image/png", extension: ".png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mediaType: "image/jpeg", extension: ".jpg" };
  }
  const header6 = buffer.subarray(0, 6).toString("ascii");
  if (header6 === "GIF87a" || header6 === "GIF89a") {
    return { mediaType: "image/gif", extension: ".gif" };
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mediaType: "image/webp", extension: ".webp" };
  }
  throw new InputError("Clipboard data is not a supported PNG, JPEG, GIF, or WebP image.");
}

async function removeCaptured(items, destination) {
  let canonicalDestination;
  try {
    canonicalDestination = await realpath(destination);
  } catch {
    // Without a canonical private root, no captured path is safe to remove.
    return;
  }
  for (const item of items) {
    if (typeof item?.path !== "string") {
      continue;
    }
    let resolved;
    try {
      resolved = await realpath(item.path);
    } catch {
      continue;
    }
    if (pathIsWithinRoot(canonicalDestination, resolved)) {
      await unlink(resolved).catch(() => {});
    }
  }
}

export async function captureWindowsClipboard(destination, options = {}) {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new InputError("Direct clipboard image capture is currently supported on Windows only.");
  }
  const environment = options.environment ?? process.env;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const processResult = await executeProcess(
    options.powershellPath ?? windowsPowerShellPath(environment),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      CAPTURE_SCRIPT,
      "-Destination",
      destination,
    ],
    {
      cwd: destination,
      timeoutMs: 15_000,
      environment,
      maxOutputBytes: 1024 * 1024,
    },
  );
  if (processResult.exitCode !== 0) {
    throw new InputError(processResult.stderr.trim() || "Unable to read an image from the Windows clipboard.");
  }
  let parsed;
  try {
    parsed = JSON.parse(processResult.stdout.trim());
  } catch {
    throw new InputError("The clipboard helper returned an invalid response.");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new InputError("The clipboard helper returned no supported images.");
  }
  return parsed;
}

export async function validateCapturedImages(capture, destination) {
  const canonicalDestination = await realpath(destination);
  const normalized = [];
  for (const rawItem of capture.items) {
    if (!isRecord(rawItem) || typeof rawItem.path !== "string") {
      throw new InputError("The clipboard helper returned an invalid image entry.");
    }
    const resolved = await realpath(rawItem.path);
    if (!pathIsWithinRoot(canonicalDestination, resolved)) {
      throw new InputError("The clipboard helper returned a path outside its private image directory.");
    }
    const details = await stat(resolved);
    if (!details.isFile() || details.size <= 0 || details.size > MAX_IMAGE_BYTES) {
      throw new InputError("Each queued image must be a non-empty file no larger than 25 MiB.");
    }
    const identified = identifyImage(await readMagic(resolved));
    normalized.push({
      id: randomUUID().replaceAll("-", "").slice(0, 8),
      storedPath: resolved,
      sourceName: typeof rawItem.sourceName === "string"
        ? path.basename(rawItem.sourceName).slice(0, 255)
        : `clipboard${identified.extension}`,
      sourceFormat: typeof rawItem.sourceFormat === "string"
        ? rawItem.sourceFormat.slice(0, 64)
        : "unknown",
      byteExact: rawItem.byteExact === true,
      mediaType: identified.mediaType,
      sizeBytes: details.size,
      addedAt: new Date().toISOString(),
    });
  }
  return normalized;
}

export async function addClipboardImages(state, dataRoot, sessionId, options = {}) {
  const destination = sessionImageDirectory(dataRoot, sessionId);
  const captureFunction = options.captureFunction ?? captureWindowsClipboard;
  const capture = await captureFunction(destination, options);
  try {
    if (
      options.force !== true
      && state.lastClipboardSequence !== null
      && String(state.lastClipboardSequence) === String(capture.clipboardSequence)
    ) {
      throw new InputError("剪贴板内容与上次 image add 相同；如需重复加入，请使用 /claude image add --force。");
    }
    const images = await validateCapturedImages(capture, destination);
    const combined = [...state.images, ...images];
    if (combined.length > MAX_IMAGES) {
      throw new InputError(`图片队列最多保存 ${MAX_IMAGES} 张图片。`);
    }
    const totalBytes = combined.reduce((sum, image) => sum + image.sizeBytes, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new InputError("图片队列总大小不能超过 100 MiB。");
    }
    state.images = combined;
    state.lastClipboardSequence = String(capture.clipboardSequence);
    return images;
  } catch (error) {
    await removeCaptured(capture.items, destination);
    throw error;
  }
}

export async function clearQueuedImages(state, dataRoot, sessionId, selectedIds) {
  const destination = sessionImageDirectory(dataRoot, sessionId);
  let canonicalDestination;
  try {
    canonicalDestination = await realpath(destination);
  } catch (error) {
    if (state.images.length === 0 && error && typeof error === "object" && error.code === "ENOENT") {
      state.lastClipboardSequence = null;
      return 0;
    }
    throw new InputError("The private session image directory is unavailable; refusing to remove queued paths.");
  }
  const selected = selectedIds === undefined ? null : new Set(selectedIds);
  const kept = [];
  let removed = 0;
  for (const image of state.images) {
    if (selected !== null && !selected.has(image.id)) {
      kept.push(image);
      continue;
    }
    const resolved = path.resolve(image.storedPath);
    if (!pathIsWithinRoot(canonicalDestination, resolved)) {
      throw new InputError("Refusing to remove an image outside the private session queue.");
    }
    await unlink(resolved).catch((error) => {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) {
        throw error;
      }
    });
    removed += 1;
  }
  state.images = kept;
  if (state.images.length === 0) {
    state.lastClipboardSequence = null;
    await rmdir(destination).catch((error) => {
      if (!(error && typeof error === "object" && ["ENOENT", "ENOTEMPTY"].includes(error.code))) {
        throw error;
      }
    });
  }
  return removed;
}

export function formatImageQueue(images) {
  if (images.length === 0) {
    return "图片队列为空。";
  }
  const lines = images.map((image, index) => {
    const exact = image.byteExact ? "原始字节" : "像素无损 PNG";
    const sizeMiB = (image.sizeBytes / (1024 * 1024)).toFixed(2);
    return `${index + 1}. ${image.sourceName} · ${image.mediaType} · ${sizeMiB} MiB · ${exact} · ID ${image.id}`;
  });
  return [`已排队 ${images.length} 张图片：`, ...lines].join("\n");
}
