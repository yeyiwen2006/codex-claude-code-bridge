import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleHookEvent } from "../server/lib/command-handler.mjs";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let temporaryRoot;
let projectDirectory;
let pluginData;
let pluginDirectory;

before(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "claude-code-bridge-command-"));
  projectDirectory = path.join(temporaryRoot, "project");
  pluginData = path.join(temporaryRoot, "plugin-data");
  pluginDirectory = path.join(temporaryRoot, "reviewer-plugin");
  await Promise.all([
    mkdir(projectDirectory, { recursive: true }),
    mkdir(path.join(pluginDirectory, ".claude-plugin"), { recursive: true }),
    mkdir(path.join(pluginDirectory, "skills", "inspect"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(pluginDirectory, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "reviewer" })}\n`,
      "utf8",
    ),
    writeFile(
      path.join(pluginDirectory, "skills", "inspect", "SKILL.md"),
      "---\nname: inspect\ndescription: Inspect a fixture.\n---\n\nInspect it.\n",
      "utf8",
    ),
  ]);
});

after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

test("intercepts commands, queues multiple images in order, and runs without a Codex model", async () => {
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const environment = { ...process.env, PLUGIN_DATA: pluginData };
  const runInputs = [];
  let captureCall = 0;

  const dependencies = {
    environment,
    getClaudeHealth: async () => ({
      installed: true,
      authenticated: true,
      version: "9.9.9 (Claude Code)",
    }),
    getClaudePluginInventory: async () => [],
    runClaude: async (input) => {
      runInputs.push(input);
      return {
        ok: true,
        type: "result",
        subtype: "success",
        result: `mock-result-${runInputs.length}`,
        session_id: "11111111-2222-4333-8444-555555555555",
        exit_code: 0,
        elapsed_ms: 10,
        permission_denials: [],
      };
    },
    captureClipboard: async (destination) => {
      captureCall += 1;
      await mkdir(destination, { recursive: true });
      const count = captureCall === 1 ? 2 : 1;
      const items = [];
      for (let index = 0; index < count; index += 1) {
        const filePath = path.join(destination, `capture-${captureCall}-${index}.png`);
        await writeFile(filePath, PNG_1X1);
        items.push({
          path: filePath,
          sourceName: `image-${captureCall}-${index}.png`,
          sourceFormat: "test",
          byteExact: true,
        });
      }
      return { clipboardSequence: String(captureCall), items };
    },
  };

  const submit = (prompt) => handleHookEvent({
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    cwd: projectDirectory,
    prompt,
  }, dependencies);

  assert.equal(await submit("普通 Codex 消息"), null);
  assert.match((await submit("/claude help")).reason, /不调用 Codex 模型/);
  assert.match((await submit("/claude access allow .")).reason, /已授权目录/);
  assert.match((await submit("/claude config set approval auto")).reason, /approval: auto/);

  assert.match((await submit("/claude image add")).reason, /本次加入 2 张图片/);
  assert.match((await submit("/claude image add")).reason, /已排队 3 张图片/);
  const list = await submit("/claude image list");
  assert.match(list.reason, /image-1-0\.png/);
  assert.match(list.reason, /image-1-1\.png/);
  assert.match(list.reason, /image-2-0\.png/);

  const imageRun = await submit("/claude image run -- 对比三张图片");
  assert.match(imageRun.reason, /mock-result-1/);
  assert.equal(runInputs.length, 1);
  assert.equal(runInputs[0].prompt, "对比三张图片");
  assert.equal(runInputs[0].imagePaths.length, 3);
  assert.deepEqual(
    runInputs[0].imagePaths.map((filePath) => path.basename(filePath)),
    ["capture-1-0.png", "capture-1-1.png", "capture-2-0.png"],
  );
  assert.match((await submit("/claude image list")).reason, /图片队列为空/);

  await submit("/claude config set approval ask");
  const staged = await submit("/claude run -- 修改一个文件");
  const approvalId = /approve ([0-9a-f]{8})/.exec(staged.reason)?.[1];
  assert.ok(approvalId);
  assert.equal(runInputs.length, 1);
  const approved = await submit(`/claude approve ${approvalId}`);
  assert.match(approved.reason, /mock-result-2/);
  assert.equal(runInputs.length, 2);

  await submit("/claude config set customizations plugin-only");
  await submit(`/claude plugin add "${pluginDirectory}"`);
  assert.match((await submit("/claude skill list")).reason, /reviewer:inspect/);
  await submit("/claude config set approval auto");
  const strictPlan = await submit("/claude plan -- 只读检查");
  assert.match(strictPlan.reason, /mock-result-3/);
  assert.equal(runInputs[2].customizationSources, "safe");
  assert.equal(runInputs[2].persistSession, false);
  assert.deepEqual(runInputs[2].pluginDirectories, []);
  const skillRun = await submit("/claude skill run reviewer:inspect -- fixture argument");
  assert.match(skillRun.reason, /mock-result-4/);
  assert.equal(runInputs[3].prompt, "/reviewer:inspect fixture argument");
  assert.deepEqual(runInputs[3].pluginDirectories, [await realpath(pluginDirectory)]);

  await handleHookEvent({
    hook_event_name: "SessionEnd",
    session_id: sessionId,
    cwd: projectDirectory,
  }, dependencies);
  await assert.rejects(access(path.join(pluginData, "state", "sessions", `${sessionId}.json`)));
});
