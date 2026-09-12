#!/usr/bin/env node

// Opt-in integration evidence: real Claude Code, an in-process loopback provider,
// and isolated temporary state. This is not a test of real cloud outages.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startClaudeJob } from "../../server/lib/claude-job-manager.mjs";
import { getCommandConfiguration } from "../../server/lib/claude-runner.mjs";
import { loadSessionState, saveCommandConfig, DEFAULT_COMMAND_CONFIG } from "../../server/lib/state-store.mjs";
import { normalizeRunInput } from "../../server/lib/validation.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execAsync = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const index = entry.indexOf("=");
  return index < 0 ? [entry.replace(/^--/, ""), true] : [entry.slice(2, index), entry.slice(index + 1)];
}));
for (const key of Object.keys(options)) assert.ok(["claude", "codex", "smoke", "host-only"].includes(key), `Unknown option: ${key}`);
assert.ok(!options["host-only"] || options.codex, "--host-only requires --codex=<absolute executable>");
assert.ok(!(options["host-only"] && options.smoke), "--host-only and --smoke are mutually exclusive");
const root = await mkdtemp(path.join(os.tmpdir(), "bridge-fault-recovery-"));
const work = path.join(root, "project");
const dataRoot = path.join(root, "data");
const profile = path.join(root, "profile");
await mkdir(work, { recursive: true });
await mkdir(profile, { recursive: true });
const report = { kind: "real-cli-loopback-provider-fault-injection", root, startedAt: new Date().toISOString(), cases: [], limitations: [
  "Uses the actual Claude Code executable but a local scripted Anthropic-compatible provider; no real provider outage or quota was induced.",
  "Short bounded concurrency and repetition only; not an hours-long soak test.",
] };
const routes = new Map();
const sockets = new Set();
let activeRequests = 0;
let maximumActiveRequests = 0;
let hostGuardRequests = 0;
const server = http.createServer(async (request, response) => {
  // Never inspect, collect, or report authorization headers.
  if (request.url.startsWith("/host-guard")) {
    hostGuardRequests += 1;
    request.resume();
    response.writeHead(503, { "content-type": "application/json" }).end('{"error":{"message":"QA_HOST_MODEL_FORBIDDEN"}}');
    return;
  }
  const route = routes.get(new URL(request.url, "http://localhost").pathname.split("/")[1]);
  request.on("error", () => {});
  if (!route) { response.writeHead(404).end(); return; }
  let body = "";
  for await (const chunk of request) body += chunk;
  let input;
  try { input = JSON.parse(body || "{}"); } catch { response.writeHead(400).end(); return; }
  if (request.url.includes("count_tokens")) {
    response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
    return;
  }
  if (!request.url.includes("/messages")) { response.writeHead(200).end("{}"); return; }
  route.requests += 1;
  activeRequests += 1;
  maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
  response.once("close", () => { activeRequests -= 1; });
  const mode = route.requests <= route.failures ? route.mode : "healthy";
  if (mode === "disconnect") { request.socket.destroy(); return; }
  if (mode === "stall") { route.openResponse = response; return; }
  if (mode === "429" || mode === "503") {
    response.writeHead(Number(mode), { "content-type": "application/json", "retry-after": "0" });
    response.end(JSON.stringify({ type: "error", error: {
      type: mode === "429" ? "rate_limit_error" : "overloaded_error", message: `LOCAL_QA_${mode}`,
    } }));
    return;
  }
  if (route.latency) await delay(route.latency);
  const message = { id: `msg_${route.id}`, type: "message", role: "assistant", model: input.model || "claude-sonnet-4-5",
    content: [{ type: "text", text: route.marker }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 } };
  if (!input.stream) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  event("content_block_delta", { index: 0, delta: { type: "text_delta", text: route.marker } });
  event("content_block_stop", { index: 0 });
  event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  event("message_stop", {});
  response.end();
});
server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

function routeFor(id, mode = "healthy", failures = 0, latency = 0) {
  const route = { id, mode, failures, latency, marker: `LOCAL_QA_OK_${id}`, requests: 0 };
  routes.set(id, route);
  return route;
}

function environmentFor(route) {
  // Copy only non-secret operating-system launch settings. Do not read user
  // credentials, user settings files, or values of arbitrary environment keys.
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SHELL", "CLAUDE_CODE_GIT_BASH_PATH"];
  const environment = Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return { ...environment, HOME: profile, USERPROFILE: profile, CLAUDE_CONFIG_DIR: path.join(profile, "claude-config", route.id),
    ANTHROPIC_API_KEY: "local-qa-dummy-not-a-secret", ANTHROPIC_BASE_URL: `${origin}/${route.id}`,
    ANTHROPIC_MODEL: "claude-sonnet-4-5", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-4-5",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ...(options.claude ? { CLAUDE_CODE_BRIDGE_COMMAND: options.claude } : {}),
  };
}

async function waitFor(check, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await check();
    if (found) return found;
    await delay(50);
  }
  throw new Error("bounded QA wait timed out");
}

async function runJob(route, { sessionId = randomUUID(), timeout = 12 } = {}) {
  const input = await normalizeRunInput({ prompt: `Reply exactly ${route.marker}. Do not use tools.`, working_directory: work,
    permission_mode: "plan", timeout_seconds: timeout, customization_sources: "safe", persist_session: false });
  const began = Date.now();
  const text = await startClaudeJob({ prompt: input.prompt, taskPrompt: input.prompt, input, imageIds: [], authorizationRoot: work,
    conversation: { messageCount: 0, truncated: false } }, { dataRoot, sessionId, environment: environmentFor(route) });
  const state = await loadSessionState(dataRoot, sessionId);
  const outcome = { id: route.id, sessionId, mode: route.mode, milliseconds: Date.now() - began, requests: route.requests,
    status: state.bridgeHistory.at(-1)?.status, activeJobCleared: state.activeJob === null,
    markerReturned: text.includes(route.marker), timeoutReported: text.includes("-second timeout"),
    pendingApprovalCleared: !state.activeJob?.pendingApproval, jobFiles: await readdir(path.join(dataRoot, "jobs", sessionId)).catch(() => []) };
  report.cases.push(outcome);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  assert.equal(outcome.activeJobCleared, true);
  assert.equal(outcome.pendingApprovalCleared, true);
  assert.deepEqual(outcome.jobFiles, []);
  assert.ok(route.requests > 0, "the real binary reached the fault provider");
  return outcome;
}

async function basicCases() {
  const baseline = await runJob(routeFor("baseline"));
  assert.equal(baseline.status, "completed");
  assert.equal(baseline.markerReturned, true);
  if (options.smoke) return;
  for (const mode of ["disconnect", "429", "503", "stall"]) {
    const sessionId = randomUUID();
    const failed = await runJob(routeFor(`persistent-${mode}`, mode, Infinity), { sessionId, timeout: 10 });
    assert.equal(failed.status, "failed");
    assert.equal(failed.markerReturned, false, "failure must not look successful");
    assert.ok(failed.milliseconds < 30_000);
    const recovered = await runJob(routeFor(`recover-${mode}`), { sessionId });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.markerReturned, true);
  }
  const transient = await runJob(routeFor("transient-429", "429", 1));
  assert.equal(transient.status, "completed");
  assert.ok(transient.requests >= 2);
  const began = Date.now();
  const concurrent = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => runJob(routeFor(`concurrent-${index}`, "healthy", 0, 500), { timeout: 25 })));
  assert.ok(concurrent.every((entry) => entry.status === "fulfilled" && entry.value.status === "completed" && entry.value.markerReturned));
  report.concurrency = { sessions: 10, milliseconds: Date.now() - began, maximumOverlappingHttpRequests: maximumActiveRequests };
  assert.ok(maximumActiveRequests > 1, "real provider requests overlap");
  const repeatedSession = randomUUID();
  const repeatBegan = Date.now();
  for (let index = 0; index < 30; index += 1) {
    const result = await runJob(routeFor(`repeat-${index}`), { sessionId: repeatedSession });
    assert.equal(result.status, "completed");
    assert.equal(result.markerReturned, true);
  }
  report.repetition = { rounds: 30, sessionId: repeatedSession, milliseconds: Date.now() - repeatBegan };
}

async function stopOwnedProcess(child, tree = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0 && child.pid !== process.pid);
  const closed = new Promise((resolve) => child.once("close", resolve));
  if (tree && process.platform === "win32") {
    await execAsync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else child.kill("SIGKILL");
  await Promise.race([closed, delay(5_000).then(() => { throw new Error("owned host did not close"); })]);
}

function startHost(binary, home, environment) {
  const child = spawn(binary, ["app-server", "--stdio"], {
    cwd: work, env: { ...environment, CODEX_HOME: home }, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  const pending = new Map();
  let sequence = 0;
  child.stderr.resume(); // No raw host logging; the report contains selected evidence only.
  child.stdin.on("error", () => {});
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (pending.has(event.id)) {
      const request = pending.get(event.id);
      pending.delete(event.id);
      clearTimeout(request.timer);
      if (event.error) request.reject(new Error(JSON.stringify(event.error)));
      else request.resolve(event.result);
    } else {
      events.push(event);
      if (event.id !== undefined) child.stdin.write(`${JSON.stringify({ id: event.id,
        error: { code: -32601, message: "QA client rejects unexpected host requests" } })}\n`);
    }
  });
  const rejectPending = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("owned host closed")); }
    pending.clear();
  };
  child.once("close", rejectPending);
  child.once("error", rejectPending);
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} exceeded 30 seconds`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  return { child, events, rpc };
}

async function prepareHost(host) {
  await host.rpc("initialize", { clientInfo: { name: "bridge_fault_recovery_qa", version: "0.3.6" }, capabilities: { experimentalApi: true } });
  host.child.stdin.write('{"method":"initialized","params":{}}\n');
  const hooks = await host.rpc("hooks/list", { cwds: [work] });
  const pluginHooks = hooks.data.flatMap((entry) => entry.hooks).filter((hook) => hook.pluginId === "codex-claude-code-bridge@personal");
  assert.ok(pluginHooks.some((hook) => hook.enabled && hook.eventName === "userPromptSubmit"), "isolated plugin hook is enabled");
  // Accept the app-server's own trust record for this reviewed temporary copy.
  // No hashes are computed or compared and no user configuration is read.
  await host.rpc("config/value/write", { keyPath: "hooks.state", value: Object.fromEntries(pluginHooks.map((hook) =>
    [hook.key, { trusted_hash: hook.currentHash }])), mergeStrategy: "upsert" });
}

async function hostTurn(host, threadId, command) {
  const before = host.events.length;
  const { turn } = await host.rpc("turn/start", { threadId, input: [{ type: "text", text: command }] });
  await waitFor(() => host.events.slice(before).find((event) => event.method === "turn/completed" && event.params.turn.id === turn.id));
  const hook = host.events.slice(before).find((event) => event.method === "hook/completed" && event.params.turnId === turn.id && event.params.run.eventName === "userPromptSubmit");
  assert.ok(hook, "the real host executed UserPromptSubmit");
  assert.equal(hook.params.run.status, "blocked");
  return hook.params.run.entries.map((entry) => entry.text).join("\n");
}

async function hostCrashCase() {
  assert.ok(options.codex, "--codex=<absolute executable> is required for host recovery");
  const home = path.join(root, "codex-home");
  const cache = path.join(home, "plugins/cache/personal/codex-claude-code-bridge/0.3.6");
  const hostData = path.join(home, "plugins/data/codex-claude-code-bridge-personal");
  await mkdir(cache, { recursive: true });
  for (const name of ["server", "scripts", "hooks", "skills", ".codex-plugin", ".mcp.json", "package.json"]) {
    await cp(path.join(repository, name), path.join(cache, name), { recursive: true });
  }
  await writeFile(path.join(home, "config.toml"), [
    'model = "qa-never-called"', 'model_provider = "qa_guard"',
    '[model_providers.qa_guard]', 'name = "Local QA host guard"', `base_url = "${origin}/host-guard"`,
    'wire_api = "responses"', 'requires_openai_auth = false',
    '[plugins."codex-claude-code-bridge@personal"]', 'enabled = true', "",
  ].join("\n"), "utf8");
  await saveCommandConfig(hostData, { ...DEFAULT_COMMAND_CONFIG, permission: "plan", customizations: "safe", conversationContext: false, timeoutSeconds: 20 });
  const route = routeFor("host-crash", "stall", Infinity);
  const environment = environmentFor(route);
  const version = await execAsync(options.codex, ["--version"], { env: environment, windowsHide: true });
  let first = startHost(options.codex, home, environment);
  let second;
  let threadId;
  let originalJob;
  const stage = (value) => { report.hostStage = value; };
  try {
    stage("initialize first host");
    await prepareHost(first);
    stage("start persistent thread");
    ({ thread: { id: threadId } } = await first.rpc("thread/start", { cwd: work, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: false }));
    stage("authorize project");
    await hostTurn(first, threadId, "claude access allow .");
    stage("start stalled provider request");
    await first.rpc("turn/start", { threadId, input: [{ type: "text", text: "claude run -- Reply LOCAL_QA_STALLED without tools." }] });
    originalJob = await waitFor(async () => {
      const state = await loadSessionState(hostData, threadId);
      return route.requests > 0 && state.activeJob?.workerPid ? state.activeJob : null;
    });
    const firstPid = first.child.pid;
    stage("force owned host tree exit");
    await stopOwnedProcess(first.child, true);
    first = null;
    // On Windows taskkill /T includes detached descendants. Do not assume that
    // is true elsewhere: report rather than kill an unverified process.
    let workerGone = false;
    try { process.kill(originalJob.workerPid, 0); } catch (error) { if (error.code === "ESRCH") workerGone = true; else throw error; }
    assert.equal(workerGone, true, "owned host tree exit must actually remove its worker");
    const beforeRecovery = await loadSessionState(hostData, threadId);
    assert.ok(["starting", "running", "waiting"].includes(beforeRecovery.activeJob?.status), "hard exit left recoverable state");
    route.mode = "healthy";
    route.failures = 0;
    second = startHost(options.codex, home, environment);
    stage("initialize second host");
    await prepareHost(second);
    stage("resume persistent thread");
    await second.rpc("thread/resume", { threadId, cwd: work, approvalPolicy: "never", sandbox: "danger-full-access" });
    stage("recover dead worker state");
    const statusText = await hostTurn(second, threadId, "claude status");
    const recovered = (await loadSessionState(hostData, threadId)).activeJob;
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.pendingApproval, null);
    assert.equal(recovered.decision, null);
    assert.match(recovered.resultPath, /\.recovered\.md$/);
    assert.match(statusText, /failed|失败/);
    const resultText = await hostTurn(second, threadId, "claude result");
    assert.match(resultText, /失败/);
    assert.equal((await loadSessionState(hostData, threadId)).activeJob, null);
    stage("healthy request after recovery");
    const healthyText = await hostTurn(second, threadId, `claude run -- Reply ${route.marker} only; do not use tools.`);
    assert.ok(healthyText.includes(route.marker));
    const finalState = await loadSessionState(hostData, threadId);
    assert.equal(finalState.activeJob, null);
    assert.equal(finalState.bridgeHistory.at(-1).status, "completed");
    assert.equal(firstPid === second.child.pid, false);
    const tokenEvents = second.events.filter((event) => event.method === "thread/tokenUsage/updated").length;
    assert.equal(tokenEvents, 0, "deterministic hooks do not invoke the host model");
    assert.equal(hostGuardRequests, 0, "the local rejection endpoint received no host-model request");
    report.hostRecovery = { codexVersion: version.stdout.trim(), threadId, forcedExit: "owned app-server process tree", firstPid,
      secondPid: second.child.pid, workerPid: originalJob.workerPid, workerGone, originalStatus: beforeRecovery.activeJob.status,
      recoveredStatus: recovered.status, subsequentStatus: finalState.bridgeHistory.at(-1).status, tokenEvents, hostGuardRequests };
  } finally {
    if (first) await stopOwnedProcess(first.child, true);
    if (second) {
      const closed = new Promise((resolve) => second.child.once("close", resolve));
      second.child.stdin.end();
      await Promise.race([closed, delay(5_000)]);
      await stopOwnedProcess(second.child, true);
    }
  }
  await waitFor(async () => { try { await access(path.join(hostData, "state/sessions", `${threadId}.json`)); return false; } catch { return true; } }, 5_000);
  report.hostRecovery.finalSessionStateRemoved = true;
  report.hostRecovery.remainingTurnLocks = (await readdir(path.join(hostData, "locks")).catch(() => [])).filter((name) => name.startsWith("turn_"));
  report.hostRecovery.remainingReceipts = await readdir(path.join(hostData, "state/turn-receipts", threadId)).catch(() => []);
  report.hostRecovery.remainingRecoveryClaims = await readdir(path.join(hostData, "locks/recovery")).catch(() => []);
  assert.deepEqual(report.hostRecovery.remainingTurnLocks, []);
  assert.deepEqual(report.hostRecovery.remainingReceipts, []);
  assert.deepEqual(report.hostRecovery.remainingRecoveryClaims, []);
  stage("completed");
  process.stdout.write(`${JSON.stringify({ hostRecovery: report.hostRecovery })}\n`);
}

let success = false;
try {
  const versionEnvironment = environmentFor(routeFor("version"));
  const { command } = getCommandConfiguration(versionEnvironment);
  const version = await execAsync(command, ["--version"], { env: versionEnvironment, windowsHide: true });
  report.claudeVersion = version.stdout.trim();
  if (!options["host-only"]) await basicCases();
  if (options.codex) await hostCrashCase();
  success = true;
} catch (error) {
  report.error = error?.code === "ERR_ASSERTION" ? "assertion-failed" : "qa-step-failed";
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  report.success = success;
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ success, reportPath: path.join(root, "report.json"), error: report.error })}\n`);
}
