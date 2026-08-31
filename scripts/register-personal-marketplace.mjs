#!/usr/bin/env node

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_NAME = "claude-code-bridge";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDirectory, "..");
const expectedPluginRoot = path.join(os.homedir(), "plugins", PLUGIN_NAME);
const marketplacePath = path.join(os.homedir(), ".agents", "plugins", "marketplace.json");

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

if (comparable(pluginRoot) !== comparable(expectedPluginRoot)) {
  process.stderr.write(
    `This registration script expects the repository at:\n${expectedPluginRoot}\n\nCurrent location:\n${pluginRoot}\n\nClone or move the repository to the expected location, then run this script again.\n`,
  );
  process.exit(1);
}

let marketplace;
let existingText;
try {
  existingText = await readFile(marketplacePath, "utf8");
  marketplace = JSON.parse(existingText);
} catch (error) {
  if (error && typeof error === "object" && error.code === "ENOENT") {
    marketplace = {
      name: "personal",
      interface: { displayName: "Personal" },
      plugins: [],
    };
  } else {
    process.stderr.write(`Unable to read a valid marketplace file: ${error.message}\n`);
    process.exit(1);
  }
}

if (
  marketplace === null
  || typeof marketplace !== "object"
  || typeof marketplace.name !== "string"
  || !Array.isArray(marketplace.plugins)
) {
  process.stderr.write("The existing personal marketplace has an unsupported structure; no changes were made.\n");
  process.exit(1);
}

const entry = {
  name: PLUGIN_NAME,
  source: {
    source: "local",
    path: `./plugins/${PLUGIN_NAME}`,
  },
  policy: {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL",
  },
  category: "DeveloperTools",
};

const existingIndex = marketplace.plugins.findIndex((plugin) => plugin?.name === PLUGIN_NAME);
if (existingIndex >= 0) {
  marketplace.plugins[existingIndex] = entry;
} else {
  marketplace.plugins.push(entry);
}
if (!marketplace.interface || typeof marketplace.interface !== "object") {
  marketplace.interface = { displayName: "Personal" };
}

await mkdir(path.dirname(marketplacePath), { recursive: true });
if (existingText !== undefined) {
  await copyFile(marketplacePath, `${marketplacePath}.claude-code-bridge.bak`);
}
const temporaryPath = `${marketplacePath}.claude-code-bridge.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
await rename(temporaryPath, marketplacePath);

process.stdout.write(
  `Registered ${PLUGIN_NAME} in marketplace '${marketplace.name}'.\nNext: codex plugin add ${PLUGIN_NAME}@${marketplace.name} --json\n`,
);
