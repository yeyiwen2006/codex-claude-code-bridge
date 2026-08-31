#!/usr/bin/env node

import { handleHookEvent } from "../server/lib/command-handler.mjs";

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const body = await readStandardInput();
  const input = JSON.parse(body);
  const output = await handleHookEvent(input);
  if (output !== null) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({
    decision: "block",
    reason: `Claude Code Bridge Hook 失败：${message}`,
  })}\n`);
}
