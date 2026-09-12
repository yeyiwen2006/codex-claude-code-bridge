import { readFileSync } from "node:fs";

export const BRIDGE_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
