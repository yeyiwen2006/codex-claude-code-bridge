#!/usr/bin/env node

// Opt-in integration validation; never discovered by `node --test`.
// Only fixed summaries leave this process. Raw SDK output, RPC messages,
// stderr, configuration, environment values, and credentials are not logged.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getCommandConfiguration } from "../../server/lib/claude-runner.mjs";

const execute = promisify(execFile);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginName = "codex-claude-code-bridge";
const selector = `${pluginName}@personal`;
const setupOnly = process.argv.includes("--setup-only");
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bridge-release-host-")));
const profile = path.join(root, "profile");
const codexHome = path.join(profile, ".codex");
const plugin = path.join(profile, "plugins", pluginName);
const project = path.join(root, "project");
const dataRoot = path.join(codexHome, "plugins", "data", `${pluginName}-personal`);
const reportPath = path.join(source, "artifacts", `release-host-${process.platform}.json`);
const codex = process.env.BRIDGE_QA_CODEX_BIN || "codex";
const env = {
  ...process.env,
  HOME: profile,
  USERPROFILE: profile,
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: path.join(profile, ".claude"),
};
// No host credentials or developer bridge overrides may escape into this run.
for (const name of [
  "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_ACCESS_TOKEN", "CODEX_ACCESS_TOKEN",
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "PLUGIN_DATA", "PLUGIN_ROOT",
  "CLAUDE_CODE_BRIDGE_COMMAND", "CLAUDE_CODE_BRIDGE_COMMAND_ARGS",
]) delete env[name];

const report = {
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  codexVersion: "0.153.4",
  claudeVersion: "2.1.261",
  model: "deepseek-flash[1m]",
  setupOnly,
  hookTrust: "native hooks/list metadata accepted in isolated host configuration",
  success: false,
  checks: [],
};
let stage = "setup";
let child;
let threadId;
let sequence = 0;
let hostRequests = 0;
let pluginInstalled = false;
const pending = new Map();
const events = [];
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const exists = async (target) => {
  try { await access(target); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const readState = async () => JSON.parse(await readFile(
  path.join(dataRoot, "state", "sessions", `${threadId}.json`), "utf8",
));
const check = (name, facts = {}) => {
  report.checks.push({ name, passed: true, ...facts });
  process.stdout.write(`${JSON.stringify({ check: name, passed: true })}\n`);
};
const waitFor = async (predicate, timeout = 180_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error("HOST_EXITED");
    await delay(50);
  }
  throw new Error("VALIDATION_TIMEOUT");
};
const command = async (executable, arguments_) => execute(executable, arguments_, {
  env, cwd: project, windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
});
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error("RPC_TIMEOUT"));
  }, 180_000);
  pending.set(id, { resolve, reject, timer });
  send({ id, method, params });
});
const startTurn = async (text) => {
  const offset = events.length;
  const { turn } = await rpc("turn/start", { threadId, input: [{ type: "text", text }] });
  return { offset, id: turn.id };
};
const finishTurn = async ({ offset, id }, expectedStatus = "completed") => {
  const finished = await waitFor(() => events.slice(offset).find((event) =>
    event.method === "turn/completed" && event.params.turn.id === id));
  assert.equal(finished.params.turn.status, expectedStatus);
  const hook = events.slice(offset).find((event) => event.method === "hook/completed"
    && event.params.turnId === id && event.params.run.eventName === "userPromptSubmit");
  if (expectedStatus === "completed") {
    assert.ok(hook, "The real host must execute the prompt hook");
    assert.equal(hook.params.run.status, "blocked");
  }
  assert.equal(hostRequests, 0, "A command must never reach the host model endpoint");
  return hook?.params.run.entries.map((entry) => entry.text).join("\n") ?? "";
};
const runTurn = async (text) => finishTurn(await startTurn(text));

// A loopback sink makes accidental host generation observable and prevents
// fallback to a paid Codex model even if interception regresses.
const deniedHost = createServer((request, response) => {
  hostRequests += 1;
  request.resume();
  response.writeHead(400, { "content-type": "application/json" });
  response.end('{"error":{"message":"Host model calls are forbidden in this test"}}');
});
await new Promise((resolve) => deniedHost.listen(0, "127.0.0.1", resolve));

try {
  await mkdir(project, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
  await mkdir(plugin, { recursive: true });
  for (const name of [".codex-plugin", ".mcp.json", "package.json", "hooks", "scripts", "server", "skills", "assets"]) {
    if (await exists(path.join(source, name))) {
      await cp(path.join(source, name), path.join(plugin, name), { recursive: true });
    }
  }
  const codexVersion = await command(codex, ["--version"]);
  assert.match(codexVersion.stdout, /\b0\.153\.4\b/);
  const claudeConfiguration = getCommandConfiguration(env);
  const claudeVersion = await command(claudeConfiguration.command, [...claudeConfiguration.prefixArguments, "--version"]);
  assert.match(claudeVersion.stdout, /\b2\.1\.261\b/);
  check("fixed-runtime-versions");

  stage = "register-install";
  await command(process.execPath, [path.join(plugin, "scripts", "register-personal-marketplace.mjs")]);
  const marketplace = JSON.parse(await readFile(path.join(profile, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(marketplace.name, "personal");
  assert.equal(marketplace.plugins.filter((entry) => entry.name === pluginName).length, 1);
  await command(codex, ["plugin", "add", selector, "--json"]);
  pluginInstalled = true;
  const cacheParent = path.join(codexHome, "plugins", "cache", "personal", pluginName);
  assert.ok((await readdir(cacheParent)).length > 0);
  check("isolated-marketplace-registration-and-cli-install");

  // Preserve the CLI-created plugin entry while adding only this test provider.
  const configPath = path.join(codexHome, "config.toml");
  const installedConfig = await readFile(configPath, "utf8");
  await writeFile(configPath, [
    'model = "qa-host-must-not-run"',
    'model_provider = "qa_denied"',
    installedConfig,
    '[model_providers.qa_denied]',
    'name = "QA forbidden host"',
    `base_url = "http://127.0.0.1:${deniedHost.address().port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    "",
  ].join("\n"), "utf8");

  stage = "host-start";
  child = spawn(codex, ["app-server", "--stdio"], {
    cwd: project, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  // Drain but never export raw process output; errors can contain provider data.
  child.stderr.resume();
  child.on("error", () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("HOST_SPAWN_ERROR"));
    }
    pending.clear();
  });
  child.on("exit", () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("HOST_EXITED"));
    }
    pending.clear();
  });
  child.stdin.on("error", () => {});
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error("RPC_ERROR"));
      else waiter.resolve(message.result);
    } else {
      events.push(message);
      if (message.id !== undefined) send({ id: message.id, error: {
        code: -32601, message: "Unexpected host request is forbidden in this test",
      } });
    }
  });
  await rpc("initialize", {
    clientInfo: { name: "bridge_release_host_validation", version: "0.3.6" },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized", params: {} });
  const hookList = await rpc("hooks/list", { cwds: [project] });
  const pluginHooks = hookList.data.flatMap((entry) => entry.hooks)
    .filter((hook) => hook.enabled && hook.pluginId === selector);
  const hookNames = pluginHooks.map((hook) => hook.eventName);
  for (const eventName of ["userPromptSubmit", "interrupt", "sessionEnd"]) assert.ok(hookNames.includes(eventName));
  // Equivalent to accepting the reviewed plugin's native trust prompt. Reuse
  // the host-provided trust metadata; do not compute or verify file hashes.
  await rpc("config/value/write", {
    keyPath: "hooks.state",
    value: Object.fromEntries(pluginHooks.map((hook) => [hook.key, { trusted_hash: hook.currentHash }])),
    mergeStrategy: "upsert",
  });
  const trustedHooks = await rpc("hooks/list", { cwds: [project] });
  assert.ok(trustedHooks.data.flatMap((entry) => entry.hooks).filter((hook) => hook.pluginId === selector)
    .every((hook) => hook.trustStatus === "trusted"));
  const started = await rpc("thread/start", {
    cwd: project, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: true,
  });
  threadId = started.thread.id;
  check("real-app-server-loads-three-plugin-hooks");

  stage = "directory-authorization";
  await runTurn("claude status");
  assert.equal((await readState()).authorization, null);
  await runTurn("claude access allow .");
  assert.equal(path.resolve((await readState()).authorization.root), path.resolve(project));
  check("real-host-command-interception-and-directory-authorization");

  if (!setupOnly) {
    await runTurn("claude config set customizations safe");
    await runTurn("claude config set conversation-context off");
    await runTurn("claude config set timeout-seconds 120");
    await runTurn("claude mode accept-edits");

    stage = "real-read-write";
    const sourceText = `HOST_READ_WRITE_OK 中文 ${randomUUID()}\n`;
    await writeFile(path.join(project, "source.txt"), sourceText, "utf8");
    const readWriteFeedback = await runTurn("claude run -- Use the Read tool to read source.txt in the current directory, then use the Write tool to create accepted.txt containing exactly the same complete text. Do not use any other tools. Reply COPY_DONE only after both tools succeed.");
    assert.equal(await readFile(path.join(project, "accepted.txt"), "utf8"), sourceText);
    assert.match(readWriteFeedback, /Write · 工具返回成功/);
    check("real-claude-read-and-accept-edits-utf8-write", { capturedSuccessfulWrite: true, exactUnpromptedNonceAndUtf8: true });

    stage = "manual-allow";
    await runTurn("claude mode manual");
    await runTurn("claude run -- Use the Write tool exactly once to create allowed.txt in the current directory containing exactly HOST_ALLOWED_OK 中文. Do not use any other tools. If denied, stop. Reply ALLOWED_DONE only after the Write tool succeeds.");
    const waiting = (await readState()).activeJob;
    assert.equal(waiting.status, "waiting");
    assert.equal(waiting.pendingApproval.toolName, "Write");
    assert.equal(await exists(path.join(project, "allowed.txt")), false);
    await runTurn(`claude allow ${waiting.pendingApproval.id} once`);
    assert.equal((await readFile(path.join(project, "allowed.txt"), "utf8")).trim(), "HOST_ALLOWED_OK 中文");
    const allowed = await readState();
    assert.equal(allowed.activeJob, null);
    assert.ok(allowed.bridgeHistory.some((entry) => entry.id === waiting.id && entry.status === "completed"));
    check("manual-permission-allow-resumes-the-same-real-job", { absentBeforeApproval: true, presentAfterApproval: true });

    stage = "manual-deny";
    await runTurn("claude run -- Use the Write tool exactly once to create denied.txt in the current directory containing MUST_NOT_EXIST. Do not use any other tools. If permission is denied, do not retry or use another tool; reply DENIED and stop.");
    const denied = (await readState()).activeJob;
    assert.equal(denied.status, "waiting");
    assert.equal(denied.pendingApproval.toolName, "Write");
    assert.equal(await exists(path.join(project, "denied.txt")), false);
    await runTurn(`claude deny ${denied.pendingApproval.id} -- This validation denies the write. Stop without retrying.`);
    assert.equal(await exists(path.join(project, "denied.txt")), false);
    const afterDeny = await readState();
    assert.equal(afterDeny.activeJob, null);
    assert.ok(afterDeny.bridgeHistory.some((entry) => entry.id === denied.id));
    check("real-manual-denial-prevents-the-file-write");

    stage = "real-interrupt";
    await runTurn("claude mode bypass");
    const running = await startTurn("claude run -- Use the Bash tool to run exactly this command in the current directory: printf QA_SLEEP_STARTED > interrupt-started.txt; sleep 30. After it finishes, use the Write tool to create interrupted.txt containing MUST_NOT_EXIST. If interrupted or cancelled, stop immediately.");
    await waitFor(() => exists(path.join(project, "interrupt-started.txt")));
    const interruptJob = (await readState()).activeJob;
    assert.equal(interruptJob.status, "running");
    assert.ok(Number.isSafeInteger(interruptJob.workerPid) && interruptJob.workerPid > 0);
    await rpc("turn/interrupt", { threadId, turnId: running.id });
    await finishTurn(running, "interrupted");
    await waitFor(() => events.slice(running.offset).some((event) =>
      event.method === "hook/completed" && event.params.run.eventName === "interrupt"), 15_000);
    await runTurn("claude status");
    const interrupted = await waitFor(async () => {
      const state = await readState();
      return state.activeJob?.status === "cancelled" ? state.activeJob : null;
    }, 15_000);
    assert.equal(interrupted.pendingApproval, null);
    await runTurn("claude result");
    assert.equal((await readState()).activeJob, null);
    assert.equal(await exists(path.join(project, "interrupted.txt")), false);
    check("real-host-interrupt-cancels-a-running-claude-tool", { toolStartedBeforeInterrupt: true, targetFileAbsent: true });

    stage = "after-interrupt-recovery";
    await runTurn("claude mode accept-edits");
    await runTurn("claude run -- Use the Write tool exactly once to create recovered.txt in the current directory containing exactly HOST_RECOVERED_OK 中文. Do not use any other tool. Reply RECOVERED_DONE only after it succeeds.");
    assert.equal((await readFile(path.join(project, "recovered.txt"), "utf8")).trim(), "HOST_RECOVERED_OK 中文");
    assert.equal((await readState()).activeJob, null);
    check("new-real-claude-job-succeeds-after-interruption");
  }

  stage = "receipt-presence-before-session-end";
  const receiptEntries = await readdir(path.join(dataRoot, "state", "turn-receipts", threadId));
  const completedReceipts = receiptEntries.filter((name) => name.endsWith(".done"));
  assert.ok(completedReceipts.length > 0, "Real commands must create receipts before testing their cleanup");
  check("real-turn-receipts-exist-before-session-end", { completedReceipts: completedReceipts.length });

  stage = "zero-host-model-use";
  assert.equal(hostRequests, 0);
  const tokenEvents = events.filter((event) => event.method === "thread/tokenUsage/updated");
  assert.equal(tokenEvents.length, 0);
  const modelItems = events.filter((event) => event.method === "item/started"
    && event.params.item.type !== "userMessage");
  assert.equal(modelItems.length, 0);
  check("zero-host-model-calls-tokens-and-generated-items", {
    endpointRequests: hostRequests, tokenUsageEvents: tokenEvents.length, generatedItems: modelItems.length,
  });
  report.success = true;
} catch (error) {
  // Do not serialize errors or assertions: their values can contain raw RPC or
  // provider output. The stage and fixed classification are sufficient triage.
  report.failure = { stage, kind: error?.code === "ERR_ASSERTION" ? "assertion" : "runtime-or-timeout" };
  process.exitCode = 1;
} finally {
  if (child) {
    child.stdin.end();
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 10_000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    for (const { timer } of pending.values()) clearTimeout(timer);
  }
  try {
    if (threadId) {
      const deadline = Date.now() + 10_000;
      let remaining;
      do {
        remaining = {
          state: await exists(path.join(dataRoot, "state", "sessions", `${threadId}.json`)),
          files: 0,
        };
        for (const directory of [
          ...["results", "jobs", "images"].map((area) => path.join(dataRoot, area, threadId)),
          path.join(dataRoot, "state", "turn-receipts", threadId),
        ]) {
          remaining.files += (await readdir(directory).catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
          })).length;
        }
        if (!remaining.state && remaining.files === 0) break;
        await delay(100);
      } while (Date.now() < deadline);
      assert.equal(remaining.state, false);
      assert.equal(remaining.files, 0);
      check("real-session-end-removes-session-results-jobs-images-and-receipts");
    }
  } catch {
    report.success = false;
    report.cleanupFailure = "session-end";
    process.exitCode = 1;
  }
  try {
    if (pluginInstalled) {
      await command(codex, ["plugin", "remove", selector, "--json"]);
      const cache = path.join(codexHome, "plugins", "cache", "personal", pluginName);
      assert.equal((await readdir(cache).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })).length, 0);
    }
    if (await exists(path.join(profile, ".agents", "plugins", "marketplace.json"))) {
      await command(process.execPath, [path.join(plugin, "scripts", "unregister-personal-marketplace.mjs"), "--yes"]);
      const marketplace = JSON.parse(await readFile(path.join(profile, ".agents", "plugins", "marketplace.json"), "utf8"));
      assert.equal(marketplace.plugins.some((entry) => entry.name === pluginName), false);
      check("cli-uninstall-and-marketplace-unregister");
    }
  } catch {
    report.success = false;
    report.uninstallFailure = true;
    process.exitCode = 1;
  }
  await new Promise((resolve) => deniedHost.close(resolve));
  report.hostModel = {
    endpointRequests: hostRequests,
    tokenUsageEvents: events.filter((event) => event.method === "thread/tokenUsage/updated").length,
  };
  if (!report.success) {
    const feedback = events.filter((event) => event.method === "hook/completed")
      .flatMap((event) => event.params.run.entries.map((entry) => entry.text)).join("\n");
    report.failureSignals = {
      authentication: /authentication|unauthorized|invalid.{0,15}(?:key|token)|401/i.test(feedback),
      rateLimit: /rate.{0,5}limit|429/i.test(feedback),
      timeout: /timed? out|timeout|超时/i.test(feedback),
      missingExecutable: /ENOENT|executable.{0,20}(?:missing|not found)/i.test(feedback),
      network: /ECONN|ENOTFOUND|connection.{0,12}(?:failed|refused)|network error/i.test(feedback),
    };
  }
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ success: report.success, failure: report.failure ?? null, checks: report.checks.length })}\n`);
}
