#!/usr/bin/env node

// Opt-in live QA. This starts real Claude calls using inherited authentication.
// No user settings, credentials, installed plugins, or repository files are changed.
// Example: node scripts/qa/live-permissions.mjs --codex /path/to/codex
// Optional: --cases deny,question-safe,question-mcp,auto,bypass,timeout
// --setup-only validates host interception and cleanup without a Claude call.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(args[index + 1] && !args[index + 1].startsWith("--"), `${name} requires a value`);
  return args[index + 1];
}
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(await readFile(path.join(source, ".codex-plugin/plugin.json"), "utf8"));
const selected = new Set(args.includes("--setup-only") ? [] : option("--cases", "deny,question-safe,question-mcp,auto,bypass,timeout").split(","));
const knownCases = new Set(["deny", "question-safe", "question-mcp", "auto", "bypass", "timeout"]);
for (const name of selected) assert.ok(knownCases.has(name), `Unknown case: ${name}`);
const codex = option("--codex", process.env.BRIDGE_QA_CODEX || "codex");
const root = await mkdtemp(path.join(os.tmpdir(), "bridge-live-permissions-"));
const home = path.join(root, "codex-home");
const profile = path.join(root, "profile");
const claudeConfig = path.join(profile, ".claude");
const project = path.join(root, "project");
const dataRoot = path.join(home, "plugins/data/codex-claude-code-bridge-personal");
const cache = path.join(home, "plugins/cache/personal/codex-claude-code-bridge", manifest.version);
await mkdir(project, { recursive: true });
await mkdir(claudeConfig, { recursive: true });
await mkdir(cache, { recursive: true });
for (const name of ["server", "scripts", "skills", "hooks", ".codex-plugin", "package.json", ".mcp.json"]) {
  await cp(path.join(source, name), path.join(cache, name), { recursive: true });
}
// Refuse unexpected host model requests locally. Claude still uses its inherited endpoint.
let hostModelRequests = 0;
const guard = http.createServer((request, response) => {
  hostModelRequests += 1;
  request.resume();
  response.writeHead(400, { "content-type": "application/json" });
  response.end('{"error":{"message":"Unexpected host model call during deterministic hook QA"}}');
});
await new Promise((resolve) => guard.listen(0, "127.0.0.1", resolve));
await writeFile(path.join(home, "config.toml"), `model = "qa-no-model"\nmodel_provider = "qa_guard"\n\n[model_providers.qa_guard]\nname = "Local QA guard"\nbase_url = "http://127.0.0.1:${guard.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n\n[plugins."codex-claude-code-bridge@personal"]\nenabled = true\n`, "utf8");
const { DEFAULT_COMMAND_CONFIG, saveCommandConfig } = await import(pathToFileURL(path.join(cache, "server/lib/state-store.mjs")));
await saveCommandConfig(dataRoot, { ...DEFAULT_COMMAND_CONFIG, permission: "manual", customizations: "safe", conversationContext: false, timeoutSeconds: 90 });
const env = { ...process.env, CODEX_HOME: home, HOME: profile, USERPROFILE: profile, CLAUDE_CONFIG_DIR: claudeConfig };
delete env.CLAUDE_CODE_BRIDGE_COMMAND;
delete env.CLAUDE_CODE_BRIDGE_COMMAND_ARGS;
delete env.PLUGIN_ROOT;
delete env.PLUGIN_DATA;
// Export only fixed facts and allowlisted metadata. Do not export raw SDK text,
// stderr, RPC errors, model tool arguments, or any environment value.
const log = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
function feedbackEvidence(feedback) {
  const separator = "[Codex Claude Code Bridge 元数据]";
  const offset = feedback.lastIndexOf(separator);
  let metadata = {};
  if (offset >= 0) {
    try { metadata = JSON.parse(feedback.slice(offset + separator.length).trim()); } catch { /* No raw output in reports. */ }
  }
  const fileOperations = Array.isArray(metadata.file_operations) ? metadata.file_operations : [];
  return {
    ok: metadata.ok === true,
    expectedAnswerReturned: feedback.includes("QA_ANSWER_BLUE"),
    timeoutReported: /timed out|timeout|超时/i.test(feedback),
    toolSuccessCount: fileOperations.filter((entry) => entry.status === "succeeded").length,
    toolFailureCount: fileOperations.filter((entry) => entry.status === "failed").length,
    permissionDenialCount: Array.isArray(metadata.permission_denials) ? metadata.permission_denials.length : 0,
    elapsedMs: Number.isFinite(metadata.elapsed_ms) ? metadata.elapsed_ms : null,
    turns: Number.isFinite(metadata.num_turns) ? metadata.num_turns : null,
  };
}
const report = { source, root, selected: [...selected], startedAt: new Date().toISOString(), cases: [], commands: [] };
// Only the reviewed repository copy is enabled in this fresh, isolated home.
const child = spawn(codex, ["app-server", "--stdio"], { cwd: project, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let sequence = 0;
let threadId;
let hostError;
const pending = new Map();
const events = [];
child.stderr.resume();
child.stdin.on("error", () => {});
child.on("error", (error) => { hostError = error; });
child.on("exit", (code) => {
  hostError ||= new Error(`Host exited with status ${code}`);
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(hostError); }
  pending.clear();
});
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) {
    const item = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(item.timer);
    message.error ? item.reject(new Error("Host RPC failed")) : item.resolve(message.result);
    return;
  }
  events.push(message);
  if (message.id !== undefined) child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "QA client rejects unexpected host requests" } })}\n`);
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  if (hostError) return reject(hostError);
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 150_000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
});
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const wait = async (check, timeout = 150_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (hostError) throw hostError;
    const found = await check();
    if (found) return found;
    await delay(60);
  }
  throw new Error("Host event wait timed out");
};
const statePath = () => path.join(dataRoot, "state/sessions", `${threadId}.json`);
const receiptDirectory = () => path.join(dataRoot, "state/turn-receipts", threadId);
const readState = async () => JSON.parse(await readFile(statePath(), "utf8"));
const exists = async (file) => { try { await access(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const directoryEntries = async (directory) => {
  try { return await readdir(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
};
async function run(command) {
  const before = events.length;
  const start = Date.now();
  const { turn } = await rpc("turn/start", { threadId, input: [{ type: "text", text: command }] });
  const ended = await wait(() => events.slice(before).find((event) => event.method === "turn/completed" && event.params.turn.id === turn.id));
  assert.equal(ended.params.turn.status, "completed");
  const hook = events.slice(before).find((event) => event.method === "hook/completed" && event.params.turnId === turn.id && event.params.run.eventName === "userPromptSubmit");
  assert.ok(hook, "Real host UserPromptSubmit hook completed");
  assert.equal(hook.params.run.status, "blocked", "Hook intercepted the command before the host model");
  const feedback = hook.params.run.entries.map((entry) => entry.text).join("\n");
  report.commands.push({ commandKind: command.split(/\s+/).slice(0, 2).join(" "), turnId: turn.id, elapsedMs: Date.now() - start, evidence: feedbackEvidence(feedback) });
  return feedback;
}
async function settled(caseName, operation) {
  const start = Date.now();
  log({ starting: caseName });
  try {
    const evidence = await operation();
    const entry = { name: caseName, passed: true, elapsedMs: Date.now() - start, ...evidence };
    report.cases.push(entry);
    log(entry);
  } catch (error) {
    const state = await readState().catch(() => null);
    const entry = { name: caseName, passed: false, elapsedMs: Date.now() - start, failureKind: error?.code === "ERR_ASSERTION" ? "assertion" : "runtime-or-timeout", activeJobPresent: Boolean(state?.activeJob) };
    report.cases.push(entry);
    log(entry);
    if (state?.activeJob && ["starting", "running", "waiting"].includes(state.activeJob.status)) await run(`claude cancel ${state.activeJob.id}`);
    else if (state?.activeJob) await run("claude result");
  }
}
const filePrompt = (filename, content) => `Use the Write tool exactly once to create ${filename} in the current directory containing exactly ${content}. Do not use any other tool or alternative method. If denied, stop immediately. Reply WRITE_DONE only after successful tool output.`;

try {
  log({ root, credentialsPresent: Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.DEEPSEEK_API_KEY), initialization: await rpc("initialize", { clientInfo: { name: "bridge_live_permissions_qa", version: "0.3.6" }, capabilities: { experimentalApi: true } }) });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  const hooks = await rpc("hooks/list", { cwds: [project] });
  report.hooks = hooks.data.flatMap((entry) => entry.hooks.map(({ eventName, enabled, sourcePath, trustStatus }) => ({ eventName, enabled, sourcePath, trustStatus })));
  assert.ok(report.hooks.some((hook) => hook.enabled && hook.eventName === "userPromptSubmit"), "Reviewed bridge hook must be enabled");
  // Use the host's own trust metadata for this reviewed copy, without hashing files
  // or opening real user configuration. Some app-server versions ignore the CLI override.
  for (const hook of hooks.data.flatMap((entry) => entry.hooks)) {
    if (!hook.enabled || hook.pluginId !== "codex-claude-code-bridge@personal") continue;
    assert.ok(path.resolve(hook.sourcePath).startsWith(`${path.resolve(cache)}${path.sep}`));
    await rpc("config/value/write", { filePath: path.join(home, "config.toml"), keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: "replace" });
  }
  threadId = (await rpc("thread/start", { cwd: project, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: true })).thread.id;
  report.threadId = threadId;
  await run("claude access allow .");
  assert.equal(path.resolve((await readState()).authorization.root), path.resolve(project));
  if (selected.has("deny")) await settled("deny", async () => {
    await run(`claude run -- ${filePrompt("denied.txt", "MUST_NOT_EXIST")}`);
    const job = (await readState()).activeJob;
    assert.equal(job?.status, "waiting");
    assert.equal(job.pendingApproval.toolName, "Write");
    assert.equal(await exists(path.join(project, "denied.txt")), false);
    const feedback = await run(`claude deny ${job.pendingApproval.id} -- This isolated QA request is denied. Stop immediately and do not create the file through any alternative tool.`);
    assert.equal(await exists(path.join(project, "denied.txt")), false);
    const state = await readState();
    assert.equal(state.activeJob, null);
    assert.ok(state.bridgeHistory.some((entry) => entry.id === job.id));
    return { jobId: job.id, transport: "stdio", approvalId: job.pendingApproval.id, fileAbsent: true, evidence: feedbackEvidence(feedback) };
  });
  for (const transport of ["safe", "mcp"]) {
    if (!selected.has(`question-${transport}`)) continue;
    await settled(`question-${transport}`, async () => {
      await run(`claude config set customizations ${transport === "safe" ? "safe" : "plugin-only"}`);
      await run("claude mode manual");
      const question = "Which QA marker should be returned?";
      const prompt = `This is an interactive approval integration test. You must invoke the real AskUserQuestion tool exactly once before replying. Ask exactly \"${question}\" with two options BLUE and GREEN and multiSelect false. Do not answer the question yourself, do not put it only in text, and do not use any other tool. After receiving the user's answer reply exactly QA_ANSWER_ followed by the chosen option.`;
      const initial = await run(`claude run -- ${prompt}`);
      const job = (await readState()).activeJob;
      assert.equal(job?.status, "waiting", initial);
      assert.equal(job.pendingApproval.toolName, "AskUserQuestion");
      const actualQuestion = JSON.parse(job.pendingApproval.inputText).questions[0].question;
      assert.equal(actualQuestion, question);
      const feedback = await run(`claude answer ${job.pendingApproval.id} -- ${JSON.stringify({ [actualQuestion]: "BLUE" })}`);
      assert.match(feedback, /QA_ANSWER_BLUE/);
      assert.equal((await readState()).activeJob, null);
      return { jobId: job.id, transport: transport === "safe" ? "stdio" : "permission-prompt MCP", approvalId: job.pendingApproval.id, realQuestionConfirmed: true, evidence: feedbackEvidence(feedback) };
    });
  }
  await run("claude config set customizations safe");
  for (const mode of ["auto", "bypass"]) {
    if (!selected.has(mode)) continue;
    await settled(mode, async () => {
      await run(`claude mode ${mode}`);
      const feedback = await run(`claude run -- ${filePrompt(`${mode}.txt`, `QA_${mode.toUpperCase()}_OK 中文`)}`);
      const state = await readState();
      assert.equal(state.activeJob, null, "Native mode should complete this harmless write without a bridge approval");
      assert.equal((await readFile(path.join(project, `${mode}.txt`), "utf8")).trim(), `QA_${mode.toUpperCase()}_OK 中文`);
      return { file: `${mode}.txt`, contentVerified: true, evidence: feedbackEvidence(feedback) };
    });
  }
  if (selected.has("timeout")) await settled("timeout", async () => {
    await run("claude mode bypass");
    await run("claude config set timeout-seconds 10");
    const start = Date.now();
    const feedback = await run("claude run -- Use Bash to run sleep 30 first, then use Write to create timeout.txt containing MUST_NOT_EXIST. Do not use any other tools. If interrupted or cancelled, stop immediately.");
    const elapsedMs = Date.now() - start;
    assert.match(feedback, /timed out|timeout|超时/i);
    const state = await readState();
    assert.equal(state.activeJob, null);
    assert.equal(state.bridgeHistory.at(-1).status, "failed");
    assert.equal(await exists(path.join(project, "timeout.txt")), false);
    await run("claude config set timeout-seconds 90");
    await run("claude mode accept-edits");
    const recoveryFeedback = await run(`claude run -- ${filePrompt("after-timeout.txt", "QA_AFTER_TIMEOUT_OK 中文")}`);
    assert.equal((await readFile(path.join(project, "after-timeout.txt"), "utf8")).trim(), "QA_AFTER_TIMEOUT_OK 中文");
    assert.equal((await readState()).activeJob, null);
    return { timeoutElapsedMs: elapsedMs, terminalStatus: "failed", fileAbsent: true, subsequentWriteVerified: true, timeout: feedbackEvidence(feedback), recovery: feedbackEvidence(recoveryFeedback) };
  });
  report.hostTokenEventCount = events.filter((event) => event.method === "thread/tokenUsage/updated").length;
  assert.equal(report.hostTokenEventCount, 0, "No Codex model usage was expected");
  assert.equal(hostModelRequests, 0, "No host model HTTP requests were expected");
  const receipts = await directoryEntries(receiptDirectory());
  const lastTurnId = report.commands.at(-1).turnId;
  assert.ok(receipts.includes(`${lastTurnId}.done`), "The actual last completed turn must have created its receipt before cleanup");
  report.receiptsBeforeExit = {
    actualLastTurnReceiptPresent: true,
    completed: receipts.filter((name) => name.endsWith(".done")).length,
    pending: receipts.filter((name) => name.endsWith(".pending")).length,
  };
} catch (error) {
  report.error = error?.code === "ERR_ASSERTION" ? "assertion" : "runtime-or-timeout";
  log({ error: report.error });
} finally {
  if (threadId && !hostError) {
    const state = await readState().catch(() => null);
    if (state?.activeJob && ["starting", "running", "waiting"].includes(state.activeJob.status)) await run(`claude cancel ${state.activeJob.id}`).catch(() => {});
  }
  child.stdin.end();
  await new Promise((resolve) => {
    if (child.exitCode !== null || hostError) return resolve();
    child.once("close", resolve);
    setTimeout(() => child.kill(), 5_000).unref();
  });
  await new Promise((resolve) => guard.close(resolve));
  report.hostModelRequests = hostModelRequests;
  if (threadId) {
    await delay(500);
    report.exitCleanup = { sessionFileAbsent: !(await exists(statePath())) };
    for (const name of ["results", "jobs", "images"]) report.exitCleanup[name] = (await directoryEntries(path.join(dataRoot, name, threadId))).length;
    report.exitCleanup.turnReceipts = (await directoryEntries(receiptDirectory())).length;
  }
  const cleanupPassed = report.receiptsBeforeExit?.actualLastTurnReceiptPresent === true && report.exitCleanup?.sessionFileAbsent === true && ["results", "jobs", "images", "turnReceipts"].every((name) => report.exitCleanup[name] === 0);
  report.success = !report.error && cleanupPassed && hostModelRequests === 0 && report.cases.length === selected.size && report.cases.every((entry) => entry.passed);
  report.finishedAt = new Date().toISOString();
  const reportPath = path.join(root, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  log({ success: report.success, cases: report.cases.map(({ name, passed }) => ({ name, passed })), reportPath, exitCleanup: report.exitCleanup });
  if (!report.success) process.exitCode = 1;
}
