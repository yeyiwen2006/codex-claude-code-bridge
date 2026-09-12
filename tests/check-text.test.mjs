import assert from "node:assert/strict";
import { test } from "node:test";
import { validateUtf8Text } from "../scripts/lib/check-text.mjs";

test("release text validation preserves Chinese and rejects BOM, replacement characters and invalid UTF-8", () => {
  const text = "发布验证，中文正常。\n";
  assert.equal(validateUtf8Text(Buffer.from(text), "valid.md"), text);
  assert.throws(() => validateUtf8Text(Buffer.from(`\uFEFF${text}`), "bom.md"), /UTF-8 BOM/);
  assert.throws(() => validateUtf8Text(Buffer.from("\uFFFD"), "replacement.md"), /replacement character/);
  assert.throws(() => validateUtf8Text(Buffer.from([0xc3, 0x28]), "invalid.md"), /encoded data/);
});
