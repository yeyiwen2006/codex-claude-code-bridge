#!/usr/bin/env node

import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PLUGIN_NAME = "claude-code-bridge";
const marketplacePath = path.join(os.homedir(), ".agents", "plugins", "marketplace.json");

if (!process.argv.includes("--yes")) {
  process.stderr.write(
    `This removes only the '${PLUGIN_NAME}' entry from ${marketplacePath}. Re-run with --yes to continue.\n`,
  );
  process.exit(2);
}

let marketplace;
try {
  marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
} catch (error) {
  process.stderr.write(`Unable to read a valid marketplace file: ${error.message}\n`);
  process.exit(1);
}

if (!Array.isArray(marketplace?.plugins)) {
  process.stderr.write("The personal marketplace has an unsupported structure; no changes were made.\n");
  process.exit(1);
}

const retained = marketplace.plugins.filter((plugin) => plugin?.name !== PLUGIN_NAME);
if (retained.length === marketplace.plugins.length) {
  process.stdout.write(`${PLUGIN_NAME} was not present; no changes were made.\n`);
  process.exit(0);
}

marketplace.plugins = retained;
await copyFile(marketplacePath, `${marketplacePath}.claude-code-bridge.bak`);
const temporaryPath = `${marketplacePath}.claude-code-bridge.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
await rename(temporaryPath, marketplacePath);
process.stdout.write(`Removed only the ${PLUGIN_NAME} marketplace entry. Plugin source files were not deleted.\n`);
