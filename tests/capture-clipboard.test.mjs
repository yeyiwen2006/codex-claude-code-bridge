import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeProcess } from "../server/lib/claude-runner.mjs";

const helper = fileURLToPath(new URL("../scripts/capture-clipboard.ps1", import.meta.url));

test("clipboard file-drop helper preserves bytes and rejects excessive batches before copying", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-clipboard-helper-"));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(root)).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
    await rm(root, { recursive: true, force: true });
  });
  const runner = path.join(root, "test-file-drop.ps1");
  await writeFile(runner, `param([string]$HelperPath, [string]$FixturePath, [string]$ProgressPath)
function Write-FixtureStage([string]$Stage) {
  [System.IO.File]::AppendAllText($ProgressPath, ([DateTime]::UtcNow.ToString("O") + " " + $Stage + [Environment]::NewLine))
}
Write-FixtureStage ("script-start pid=" + $PID)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Write-FixtureStage "utf8-ready"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($HelperPath, [ref]$null, [ref]$null)
Write-FixtureStage "helper-parsed"
# Load function declarations only; never run clipboard reads or native setup.
$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($definition in $definitions) {
  Write-FixtureStage ("loading-function " + $definition.Name)
  . ([scriptblock]::Create($definition.Extent.Text))
}
Write-FixtureStage "functions-loaded"
$fixtureText = Get-Content -LiteralPath $FixturePath -Raw -Encoding UTF8
Write-FixtureStage "fixture-read"
$fixture = $fixtureText | ConvertFrom-Json
Write-FixtureStage "fixture-parsed"
$Destination = $fixture.destination
$supportedExtensions = @(".png")
try {
  Write-FixtureStage "copy-start"
  $items = Copy-ClipboardFileDrop $fixture.sources
  Write-FixtureStage "copy-complete"
  $json = @{ count = $items.Count; items = $items } | ConvertTo-Json -Depth 5 -Compress
} catch {
  Write-FixtureStage ("helper-error " + $_.Exception.Message)
  $json = @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
}
Write-FixtureStage "json-ready"
$json
Write-FixtureStage "script-complete"
`, "utf8");
  const source = path.join(root, "原图.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(source, bytes);
  let batch = 0;
  const run = async (sources) => {
    const destination = path.join(root, `batch-${batch++}`);
    await mkdir(destination);
    const fixture = path.join(root, "fixture.json");
    const progress = path.join(root, `${path.basename(destination)}-progress.log`);
    await writeFile(fixture, JSON.stringify({ destination, sources }), "utf8");
    try {
      const result = await executeProcess(
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner, "-HelperPath", helper, "-FixturePath", fixture, "-ProgressPath", progress],
        { timeoutMs: 30_000 },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      return { destination, result: JSON.parse(result.stdout) };
    } catch (error) {
      const stages = await readFile(progress, "utf8").catch((readError) => (
        `No script progress available (${readError.code}); PowerShell may not have entered the runner.`
      ));
      t.diagnostic(`Clipboard fixture ${path.basename(destination)} progress:\n${stages}`);
      throw error;
    }
  };
  const normal = await run([source]);
  assert.equal(normal.result.count, 1);
  assert.equal(normal.result.items[0].sourceName, "原图.png");
  assert.deepEqual(await readFile(normal.result.items[0].path), bytes);

  const tooMany = await run(Array(21).fill(source));
  assert.match(tooMany.result.error, /20 images/);
  assert.deepEqual(await readdir(tooMany.destination), []);
  const large = path.join(root, "large.png");
  const file = await open(large, "w");
  try {
    await file.truncate(26 * 1024 * 1024);
    const oversized = await run([source, large]);
    assert.match(oversized.result.error, /25 MiB/);
    assert.deepEqual(await readdir(oversized.destination), []);
    await file.truncate(21 * 1024 * 1024);
    const excessiveTotal = await run(Array(5).fill(large));
    assert.match(excessiveTotal.result.error, /100 MiB/);
    assert.deepEqual(await readdir(excessiveTotal.destination), []);
  } finally {
    await file.close();
  }
});
