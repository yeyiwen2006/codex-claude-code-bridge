import assert from "node:assert/strict";

export function validateUtf8Text(bytes, filePath) {
  // Preserve the BOM while decoding so the explicit check can detect it.
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  assert.equal(decoded.includes("\uFFFD"), false, `${filePath} contains a replacement character`);
  assert.equal(decoded.charCodeAt(0) === 0xFEFF, false, `${filePath} contains a UTF-8 BOM`);
  return decoded;
}
