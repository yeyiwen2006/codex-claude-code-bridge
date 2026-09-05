import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";

export const PERMISSION_MODES = Object.freeze([
  "default",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
  "plan",
]);

export const EFFORT_LEVELS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const CUSTOMIZATION_SOURCES = Object.freeze([
  "safe",
  "plugin-only",
  "user",
  "project",
  "all",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROMPT_CHARACTERS = 200_000;
const MAX_DIRECTORIES = 20;
const MAX_IMAGES = 20;
const MAX_PLUGINS = 20;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const BASE_RUN_KEYS = new Set([
  "prompt",
  "working_directory",
  "extra_directories",
  "permission_mode",
  "timeout_seconds",
  "session_id",
  "fork_session",
  "persist_session",
  "customization_sources",
  "model",
  "effort",
  "max_budget_usd",
  "allow_plugin_tools",
  "image_paths",
]);

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

export function isValidModelName(value) {
  return typeof value === "string" && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\[1m\])?$/i.test(value);
}

function requirePlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("Tool arguments must be a JSON object.");
  }
  return value;
}

function assertKnownKeys(input, allowedKeys) {
  const unknown = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new InputError(`Unknown argument(s): ${unknown.join(", ")}.`);
  }
}

function readRequiredString(input, key, maximumLength) {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InputError(`'${key}' must be a non-empty string.`);
  }
  if (value.length > maximumLength) {
    throw new InputError(`'${key}' exceeds the ${maximumLength}-character limit.`);
  }
  if (value.includes("\0")) {
    throw new InputError(`'${key}' must not contain a NUL character.`);
  }
  return value;
}

function readOptionalString(input, key, maximumLength) {
  if (input[key] === undefined) {
    return undefined;
  }
  return readRequiredString(input, key, maximumLength).trim();
}

function readBoolean(input, key, fallback) {
  if (input[key] === undefined) {
    return fallback;
  }
  if (typeof input[key] !== "boolean") {
    throw new InputError(`'${key}' must be a boolean.`);
  }
  return input[key];
}

function readEnum(input, key, values, fallback) {
  const value = input[key] ?? fallback;
  if (!values.includes(value)) {
    throw new InputError(`'${key}' must be one of: ${values.join(", ")}.`);
  }
  return value;
}

function readInteger(input, key, fallback, minimum, maximum) {
  const value = input[key] ?? fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new InputError(`'${key}' must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function readOptionalPositiveNumber(input, key, maximum) {
  if (input[key] === undefined) {
    return undefined;
  }
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new InputError(`'${key}' must be a positive number no greater than ${maximum}.`);
  }
  return value;
}

function readStringArray(input, key, maximumItems) {
  const value = input[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new InputError(`'${key}' must be an array with at most ${maximumItems} entries.`);
  }

  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0 || item.length > 32_768) {
      throw new InputError(`Every '${key}' entry must be a non-empty string of at most 32768 characters.`);
    }
    if (/\r|\n|\0/.test(item)) {
      throw new InputError(`'${key}' entries must not contain line breaks or NUL characters.`);
    }
    const trimmed = item.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }
  return normalized;
}

async function requireExistingDirectory(candidate, key) {
  if (!path.isAbsolute(candidate)) {
    throw new InputError(`'${key}' must be an absolute path.`);
  }

  let resolved;
  let details;
  try {
    resolved = await realpath(candidate);
    details = await stat(resolved);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      throw new InputError(`'${key}' does not identify an accessible directory (${error.code}).`);
    }
    throw error;
  }

  if (!details.isDirectory()) {
    throw new InputError(`'${key}' must identify a directory.`);
  }
  return resolved;
}

async function requireExistingFile(candidate, key) {
  if (!path.isAbsolute(candidate)) {
    throw new InputError(`'${key}' must be an absolute path.`);
  }
  let resolved;
  let details;
  try {
    resolved = await realpath(candidate);
    details = await stat(resolved);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      throw new InputError(`'${key}' does not identify an accessible file (${error.code}).`);
    }
    throw error;
  }
  if (!details.isFile()) {
    throw new InputError(`'${key}' must identify a file.`);
  }
  return { path: resolved, size: details.size };
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathsEqual(left, right) {
  return comparablePath(left) === comparablePath(right);
}

export function pathIsWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function pathsOverlap(left, right) {
  return pathIsWithinRoot(left, right) || pathIsWithinRoot(right, left);
}

export async function normalizeAuthorizationInput(rawInput) {
  const input = requirePlainObject(rawInput);
  assertKnownKeys(input, new Set(["directory"]));
  const requested = readRequiredString(input, "directory", 32_768).trim();
  const directory = await requireExistingDirectory(requested, "directory");
  const parsed = path.parse(directory);
  if (pathsEqual(directory, parsed.root)) {
    throw new InputError("Authorizing an entire filesystem root is not allowed.");
  }
  if (process.platform === "win32" && parsed.root.startsWith("\\\\")) {
    throw new InputError("UNC and network-share roots are not supported.");
  }

  try {
    const homeDirectory = await realpath(os.homedir());
    if (pathsEqual(directory, homeDirectory)) {
      throw new InputError("Authorizing the entire home directory is not allowed.");
    }
  } catch (error) {
    if (error instanceof InputError) {
      throw error;
    }
    // A missing or unresolvable home directory must not block a narrower authorization.
  }
  return directory;
}

export function assertAuthorizedDirectories(authorizationRoot, input) {
  const candidates = [input.workingDirectory, ...input.extraDirectories, ...input.imagePaths];
  for (const candidate of candidates) {
    if (!pathIsWithinRoot(authorizationRoot, candidate)) {
      throw new InputError(`Requested path is outside the authorized root '${authorizationRoot}'.`);
    }
  }
}

export async function normalizePluginDirectories(rawDirectories) {
  if (!Array.isArray(rawDirectories) || rawDirectories.length > MAX_PLUGINS) {
    throw new InputError(`Plugin directories must be an array with at most ${MAX_PLUGINS} entries.`);
  }
  const normalized = [];
  const seen = new Set();
  for (const raw of rawDirectories) {
    if (typeof raw !== "string" || raw.trim().length === 0 || /[\r\n\0]/.test(raw)) {
      throw new InputError("Every plugin path must be a non-empty path without control characters.");
    }
    const candidate = raw.trim();
    if (!path.isAbsolute(candidate)) {
      throw new InputError("Every plugin path must be absolute.");
    }
    let resolved;
    let details;
    try {
      resolved = await realpath(candidate);
      details = await stat(resolved);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN";
      throw new InputError(`Plugin path is inaccessible (${code}): ${candidate}`);
    }
    if (!details.isDirectory() && !(details.isFile() && path.extname(resolved).toLowerCase() === ".zip")) {
      throw new InputError("A plugin path must be a directory or a .zip file.");
    }
    const key = comparablePath(resolved);
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(resolved);
    }
  }
  return normalized;
}

export async function normalizeRunInput(rawInput, options = {}) {
  const input = requirePlainObject(rawInput);
  const allowedKeys = new Set(BASE_RUN_KEYS);
  if (options.allowPluginDirectories) {
    allowedKeys.add("plugin_directories");
  }
  assertKnownKeys(input, allowedKeys);

  const prompt = readRequiredString(input, "prompt", MAX_PROMPT_CHARACTERS);
  const workingDirectoryText = readRequiredString(input, "working_directory", 32_768).trim();
  const workingDirectory = await requireExistingDirectory(workingDirectoryText, "working_directory");

  const extraDirectoryTexts = readStringArray(input, "extra_directories", MAX_DIRECTORIES);
  const extraDirectories = [];
  for (const candidate of extraDirectoryTexts) {
    extraDirectories.push(await requireExistingDirectory(candidate, "extra_directories"));
  }

  const imagePathTexts = readStringArray(input, "image_paths", MAX_IMAGES);
  const imagePaths = [];
  for (const candidate of imagePathTexts) {
    const image = await requireExistingFile(candidate, "image_paths");
    if (!IMAGE_EXTENSIONS.has(path.extname(image.path).toLowerCase())) {
      throw new InputError("Images must be PNG, JPEG, GIF, or WebP files.");
    }
    if (image.size > 25 * 1024 * 1024) {
      throw new InputError("Each image must be no larger than 25 MiB.");
    }
    imagePaths.push(image.path);
  }

  const sessionId = readOptionalString(input, "session_id", 128);
  if (sessionId !== undefined && !UUID_PATTERN.test(sessionId)) {
    throw new InputError("'session_id' must be a UUID returned by Claude Code.");
  }

  const forkSession = readBoolean(input, "fork_session", false);
  if (forkSession && sessionId === undefined) {
    throw new InputError("'fork_session' requires 'session_id'.");
  }

  const model = readOptionalString(input, "model", 128);
  if (model !== undefined && !isValidModelName(model)) {
    throw new InputError("'model' may contain only letters, numbers, dot, underscore, colon, and hyphen, with an optional [1m] suffix.");
  }

  const customizationSources = readEnum(
    input,
    "customization_sources",
    CUSTOMIZATION_SOURCES,
    "safe",
  );
  const pluginDirectories = options.allowPluginDirectories
    ? await normalizePluginDirectories(input.plugin_directories ?? [])
    : [];
  const allowPluginTools = readBoolean(input, "allow_plugin_tools", false);
  if (customizationSources === "safe" && (pluginDirectories.length > 0 || allowPluginTools)) {
    throw new InputError("Plugin directories and plugin tools require a non-safe customization source.");
  }

  return {
    prompt,
    workingDirectory,
    extraDirectories,
    imagePaths,
    permissionMode: readEnum(input, "permission_mode", PERMISSION_MODES, "acceptEdits"),
    timeoutSeconds: readInteger(input, "timeout_seconds", 1800, 1, 3600),
    sessionId,
    forkSession,
    persistSession: readBoolean(input, "persist_session", false),
    customizationSources,
    pluginDirectories,
    allowPluginTools,
    model,
    effort: input.effort === undefined
      ? undefined
      : readEnum(input, "effort", EFFORT_LEVELS, undefined),
    maxBudgetUsd: readOptionalPositiveNumber(input, "max_budget_usd", 1000),
  };
}
