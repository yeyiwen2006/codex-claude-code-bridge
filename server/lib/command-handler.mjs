import {
  readFile,
  readdir,
  realpath,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getClaudeHealth,
  getClaudePluginInventory,
} from "./claude-runner.mjs";
import {
  composePromptWithCodexConversation,
  readCodexConversation,
} from "./codex-transcript.mjs";
import {
  cancelClaudeJob,
  describeClaudeJob,
  readClaudeJobResult,
  resolveClaudeApproval,
  startClaudeJob,
} from "./claude-job-manager.mjs";
import {
  CommandError,
  parseClaudeCommand,
  validateSkillName,
} from "./command-parser.mjs";
import {
  addClipboardImages,
  clearQueuedImages,
  formatImageQueue,
} from "./image-queue.mjs";
import {
  DEFAULT_COMMAND_CONFIG,
  loadCommandConfig,
  loadSessionState,
  removeSessionState,
  resolvePluginData,
  saveCommandConfig,
  saveSessionState,
  sessionLockName,
  withStateLock,
} from "./state-store.mjs";
import {
  CUSTOMIZATION_SOURCES,
  EFFORT_LEVELS,
  InputError,
  normalizeAuthorizationInput,
  normalizePluginDirectories,
  normalizeRunInput,
  pathIsWithinRoot,
  pathsEqual,
} from "./validation.mjs";

const AUTHORIZATION_TTL_MS = 4 * 60 * 60 * 1000;
const PERMISSION_MAP = Object.freeze({
  default: "default",
  manual: "default",
  "accept-edits": "acceptEdits",
  plan: "plan",
  edit: "acceptEdits",
  "dont-ask": "dontAsk",
  locked: "dontAsk",
  auto: "auto",
  bypass: "bypassPermissions",
  bypassPermissions: "bypassPermissions",
});
const PERMISSION_NAMES = Object.freeze(["manual", "accept-edits", "plan", "auto", "dont-ask", "bypass"]);

function canonicalPermissionName(value) {
  const mapped = PERMISSION_MAP[value];
  const names = {
    default: "manual",
    acceptEdits: "accept-edits",
    plan: "plan",
    auto: "auto",
    dontAsk: "dont-ask",
    bypassPermissions: "bypass",
  };
  return names[mapped] ?? value;
}

const HELP_TEXT = `Codex Claude Code Bridge 命令（由 Hook 直接执行，不调用 Codex 模型）

Codex App 与 CLI 通用：claude ...
Codex App 兼容别名：/claude ...
Codex CLI 会把未知 / 命令拦在 Hook 之前，因此 CLI 请勿添加斜杠。

基础
  claude help
  claude status

目录访问
  claude access allow [绝对路径|.]
  claude access show
  claude access revoke

运行
  claude plan -- <提示词>
  claude run [--permission <模式>] -- <提示词>
  claude allow <权限请求 ID> [once|session|project|user]
  claude deny <权限请求 ID> -- [原因]
  claude answer <权限请求 ID> -- <JSON 回答对象>
  claude cancel [任务 ID]
  claude result

多图
  先粘贴图片，再发送 claude image add
  每张位图重复一次；一次复制多个图片文件时会一次全部加入
  claude image list
  claude image run -- <提示词>
  claude image skill <Skill 名称> -- [参数]
  claude image clear

设置
  claude config show
  claude config set model <default|别名|完整模型名>
  claude config set effort <default|low|medium|high|xhigh|max>
  claude config set permission <manual|accept-edits|plan|auto|dont-ask|bypass>
  claude mode <default|manual|accept-edits|plan|auto|dont-ask|bypass>
  claude config set customizations <safe|plugin-only|user|project|all>
  claude config set timeout-seconds <1..3600>
  claude config set max-budget-usd <off|正数>
  claude config set persist-session <on|off>
  claude config set conversation-context <on|off>
  claude config reset [键|all]

Claude 插件与 Skills
  claude plugin list
  claude plugin add "<插件目录或 .zip 的绝对路径>"
  claude plugin remove <序号|绝对路径>
  claude skill list
  claude skill run <Skill 名称> -- [参数]

会话
  claude session show
  claude session clear
  claude session fork

权限说明
  manual 只在 Claude 真实请求权限时暂停；批准后同一进程从原处继续。
  bypass 完整使用 Claude 原生 bypassPermissions：不会由桥接器限制工具、网络或目录。
  Claude 自身的策略、ask/deny 规则、Hooks 与关键路径保护仍然生效。`;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onOff(value, key) {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new CommandError(`${key} 只能设为 on 或 off。`);
}

function validateConfig(config) {
  const candidate = { ...DEFAULT_COMMAND_CONFIG, ...config };
  if (candidate.model !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.model)) {
    throw new InputError("本地配置中的 model 无效；请执行 claude config reset model。");
  }
  if (candidate.effort !== null && !EFFORT_LEVELS.includes(candidate.effort)) {
    throw new InputError("本地配置中的 effort 无效；请执行 claude config reset effort。");
  }
  if (!Object.hasOwn(PERMISSION_MAP, candidate.permission)) {
    throw new InputError("本地配置中的 permission 无效；请重置该设置。");
  }
  candidate.permission = canonicalPermissionName(candidate.permission);
  if (!CUSTOMIZATION_SOURCES.includes(candidate.customizations)) {
    throw new InputError("本地配置中的 customizations 无效；请重置该设置。");
  }
  if (
    typeof candidate.persistSession !== "boolean"
    || typeof candidate.conversationContext !== "boolean"
  ) {
    throw new InputError("本地配置中的布尔设置无效；请重置配置。");
  }
  if (!Number.isInteger(candidate.timeoutSeconds) || candidate.timeoutSeconds < 1 || candidate.timeoutSeconds > 3600) {
    throw new InputError("本地配置中的 timeoutSeconds 无效；请重置该设置。");
  }
  if (
    candidate.maxBudgetUsd !== null
    && (typeof candidate.maxBudgetUsd !== "number" || !Number.isFinite(candidate.maxBudgetUsd)
      || candidate.maxBudgetUsd <= 0 || candidate.maxBudgetUsd > 1000)
  ) {
    throw new InputError("本地配置中的 maxBudgetUsd 无效；请重置该设置。");
  }
  if (!Array.isArray(candidate.pluginDirectories) || candidate.pluginDirectories.length > 20) {
    throw new InputError("本地配置中的 pluginDirectories 无效；请重置配置。");
  }
  return {
    model: candidate.model,
    effort: candidate.effort,
    permission: candidate.permission,
    customizations: candidate.customizations,
    timeoutSeconds: candidate.timeoutSeconds,
    maxBudgetUsd: candidate.maxBudgetUsd,
    persistSession: candidate.persistSession,
    conversationContext: candidate.conversationContext,
    pluginDirectories: [...candidate.pluginDirectories],
  };
}

function configDisplay(config) {
  const pluginState = config.customizations === "safe" ? "未加载（safe 模式）" : "已启用";
  return [
    "当前 Codex Claude Code Bridge 设置：",
    `model: ${config.model ?? "default"}`,
    `effort: ${config.effort ?? "default"}`,
    `permission: ${config.permission}`,
    `customizations: ${config.customizations}`,
    `timeout-seconds: ${config.timeoutSeconds}`,
    `max-budget-usd: ${config.maxBudgetUsd ?? "off"}`,
    `persist-session: ${config.persistSession ? "on" : "off"}`,
    `conversation-context: ${config.conversationContext ? "on" : "off"}`,
    `plugin-directories: ${config.pluginDirectories.length}（${pluginState}）`,
  ].join("\n");
}

function updateConfigValue(config, key, value) {
  const updated = { ...config };
  switch (key) {
    case "model":
      if (value === "default") {
        updated.model = null;
      } else if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
        updated.model = value;
      } else {
        throw new CommandError("model 只能包含字母、数字、点、下划线、冒号和连字符。");
      }
      break;
    case "effort":
      if (value === "default") {
        updated.effort = null;
      } else if (EFFORT_LEVELS.includes(value)) {
        updated.effort = value;
      } else {
        throw new CommandError(`effort 只能是 default、${EFFORT_LEVELS.join("、")}。`);
      }
      break;
    case "permission":
      if (!Object.hasOwn(PERMISSION_MAP, value)) {
        throw new CommandError(`permission 只能是 ${PERMISSION_NAMES.join("、")}。`);
      }
      updated.permission = canonicalPermissionName(value);
      break;
    case "customizations":
      if (!CUSTOMIZATION_SOURCES.includes(value)) {
        throw new CommandError(`customizations 只能是 ${CUSTOMIZATION_SOURCES.join("、")}。`);
      }
      updated.customizations = value;
      break;
    case "timeout-seconds": {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3600) {
        throw new CommandError("timeout-seconds 必须是 1 到 3600 的整数。");
      }
      updated.timeoutSeconds = parsed;
      break;
    }
    case "max-budget-usd": {
      if (value === "off") {
        updated.maxBudgetUsd = null;
        break;
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1000) {
        throw new CommandError("max-budget-usd 必须是 off 或不超过 1000 的正数。");
      }
      updated.maxBudgetUsd = parsed;
      break;
    }
    case "persist-session":
      updated.persistSession = onOff(value, "persist-session");
      break;
    case "conversation-context":
      updated.conversationContext = onOff(value, "conversation-context");
      break;
    default:
      throw new CommandError(`未知设置键：${key}`);
  }
  return validateConfig(updated);
}

function resetConfigValue(config, key) {
  if (key === "all") {
    return { ...DEFAULT_COMMAND_CONFIG, pluginDirectories: [] };
  }
  const map = {
    model: "model",
    effort: "effort",
    permission: "permission",
    customizations: "customizations",
    "timeout-seconds": "timeoutSeconds",
    "max-budget-usd": "maxBudgetUsd",
    "persist-session": "persistSession",
    "conversation-context": "conversationContext",
  };
  const property = map[key];
  if (!property) {
    throw new CommandError(`未知设置键：${key}`);
  }
  return { ...config, [property]: DEFAULT_COMMAND_CONFIG[property] };
}

function pruneSessionState(state) {
  let changed = false;
  if (state.authorization && state.authorization.expiresAt <= Date.now()) {
    state.authorization = null;
    state.claudeSessionId = null;
    state.claudeSessionRoot = null;
    state.forkNext = false;
    changed = true;
  }
  return changed;
}

async function mutateSession(dataRoot, sessionId, operation) {
  return withStateLock(dataRoot, sessionLockName(sessionId), async () => {
    const state = await loadSessionState(dataRoot, sessionId);
    pruneSessionState(state);
    const result = await operation(state);
    await saveSessionState(dataRoot, sessionId, state);
    return result;
  });
}

async function readSession(dataRoot, sessionId) {
  return mutateSession(dataRoot, sessionId, async (state) => JSON.parse(JSON.stringify(state)));
}

async function currentAuthorizedRoot(state, cwd) {
  if (!state.authorization) {
    throw new CommandError("尚未授权项目目录。请先执行 claude access allow .");
  }
  if (state.authorization.expiresAt <= Date.now()) {
    throw new CommandError("目录授权已过期。请重新执行 claude access allow .");
  }
  let canonicalCwd;
  try {
    canonicalCwd = await realpath(cwd);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN";
    throw new CommandError(`当前工作目录不可访问（${code}）。`);
  }
  if (!pathIsWithinRoot(state.authorization.root, canonicalCwd)) {
    throw new CommandError(`当前目录不在已授权根目录内：${state.authorization.root}`);
  }
  return { root: state.authorization.root, cwd: canonicalCwd };
}

function selectedImages(state, imageIds) {
  if (!imageIds || imageIds.length === 0) {
    return [];
  }
  const byId = new Map(state.images.map((image) => [image.id, image]));
  return imageIds.map((id) => {
    const image = byId.get(id);
    if (!image) {
      throw new CommandError(`任务所引用的图片已不在队列中：${id}`);
    }
    return image;
  });
}

async function buildRunInput(request, state) {
  const images = selectedImages(state, request.imageIds);
  const permissionMode = PERMISSION_MAP[request.permissionName];
  const activePlugins = request.config.customizations === "safe"
    ? []
    : request.config.pluginDirectories;
  const sessionMatchesRoot = state.claudeSessionId
    && state.claudeSessionRoot
    && pathsEqual(state.claudeSessionRoot, request.authorizationRoot);
  return normalizeRunInput({
    prompt: request.prompt,
    working_directory: request.workingDirectory,
    extra_directories: [],
    image_paths: images.map((image) => image.storedPath),
    permission_mode: permissionMode,
    timeout_seconds: request.config.timeoutSeconds,
    ...(request.config.persistSession && sessionMatchesRoot
      ? { session_id: state.claudeSessionId, fork_session: state.forkNext }
      : {}),
    persist_session: request.config.persistSession,
    customization_sources: request.config.customizations,
    plugin_directories: activePlugins,
    allow_plugin_tools: request.config.customizations !== "safe",
    ...(request.config.model ? { model: request.config.model } : {}),
    ...(request.config.effort ? { effort: request.config.effort } : {}),
    ...(request.config.maxBudgetUsd ? { max_budget_usd: request.config.maxBudgetUsd } : {}),
  }, { allowPluginDirectories: true });
}

function makeRequest(command, config, authorization, conversation, sessionPermission) {
  let prompt = command.prompt;
  if (command.kind === "skill-run" || command.kind === "image-skill") {
    const skill = validateSkillName(command.skill);
    prompt = `/${skill}${command.prompt.trim().length > 0 ? ` ${command.prompt}` : ""}`;
  }
  const requestedPermission = command.kind === "plan"
    ? "plan"
    : command.permissionOverride ?? sessionPermission ?? config.permission;
  if (!Object.hasOwn(PERMISSION_MAP, requestedPermission)) {
    throw new CommandError(`权限模式只能是 ${PERMISSION_NAMES.join("、")}。`);
  }
  const requestConfig = command.kind === "plan" ? { ...config, persistSession: false } : config;
  const composed = composePromptWithCodexConversation(prompt, conversation);
  return {
    prompt: composed.prompt,
    conversation: {
      available: conversation.available,
      messageCount: conversation.messageCount,
      truncated: conversation.truncated || composed.contextTruncated,
      malformedLines: conversation.malformedLines,
    },
    workingDirectory: authorization.cwd,
    authorizationRoot: authorization.root,
    permissionName: canonicalPermissionName(requestedPermission),
    imageIds: [],
    config: JSON.parse(JSON.stringify(requestConfig)),
  };
}

async function stageOrRun(command, context, config) {
  const state = await readSession(context.dataRoot, context.sessionId);
  const authorization = await currentAuthorizedRoot(state, context.cwd);
  const conversation = config.conversationContext
    ? await readCodexConversation(context.transcriptPath, { currentPrompt: context.submittedPrompt })
    : { available: false, text: "", messageCount: 0, truncated: false, malformedLines: 0 };
  const request = makeRequest(command, config, authorization, conversation, state.sessionPermission);
  if (command.kind === "image-run" || command.kind === "image-skill") {
    if (state.images.length === 0) {
      throw new CommandError("图片队列为空。请先粘贴图片并执行 claude image add。");
    }
    request.imageIds = state.images.map((image) => image.id);
  }

  const input = await buildRunInput(request, state);
  return context.dependencies.startClaudeJob({ ...request, input }, context);
}

async function pluginName(pluginDirectory) {
  try {
    const manifest = JSON.parse(await readFile(
      path.join(pluginDirectory, ".claude-plugin", "plugin.json"),
      "utf8",
    ));
    if (typeof manifest.name === "string" && /^[A-Za-z0-9_-]+$/.test(manifest.name)) {
      return manifest.name;
    }
  } catch {
    // Fall back to the directory name for local development plugins.
  }
  return path.basename(pluginDirectory).replace(/[^A-Za-z0-9_-]/g, "-");
}

async function skillsInDirectory(skillsDirectory, prefix = "") {
  let entries;
  try {
    entries = await readdir(skillsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) {
      continue;
    }
    try {
      const details = await stat(path.join(skillsDirectory, entry.name, "SKILL.md"));
      if (details.isFile()) {
        skills.push(`${prefix}${entry.name}`);
      }
    } catch {
      // Ignore directories that are not complete skills.
    }
  }
  return skills;
}

async function discoverSkills(config, cwd, dependencies) {
  const found = new Set();
  if (["user", "all"].includes(config.customizations)) {
    for (const skill of await skillsInDirectory(path.join(os.homedir(), ".claude", "skills"))) {
      found.add(skill);
    }
    const installed = await dependencies.getClaudePluginInventory().catch(() => []);
    for (const plugin of installed) {
      if (plugin.enabled !== true || typeof plugin.installPath !== "string" || typeof plugin.id !== "string") {
        continue;
      }
      const prefix = `${plugin.id.split("@", 1)[0]}:`;
      for (const skill of await skillsInDirectory(path.join(plugin.installPath, "skills"), prefix)) {
        found.add(skill);
      }
    }
  }
  if (["project", "all"].includes(config.customizations)) {
    for (const skill of await skillsInDirectory(path.join(cwd, ".claude", "skills"))) {
      found.add(skill);
    }
  }
  if (config.customizations !== "safe") {
    for (const pluginDirectory of config.pluginDirectories) {
      try {
        if (!(await stat(pluginDirectory)).isDirectory()) continue;
      } catch {
        continue;
      }
      const prefix = `${await pluginName(pluginDirectory)}:`;
      for (const skill of await skillsInDirectory(path.join(pluginDirectory, "skills"), prefix)) {
        found.add(skill);
      }
    }
  }
  return [...found].sort().slice(0, 200);
}

async function cleanupSession(dataRoot, sessionId) {
  await withStateLock(dataRoot, sessionLockName(sessionId), async () => {
    const state = await loadSessionState(dataRoot, sessionId);
    if (state.activeJob && ["starting", "running", "waiting"].includes(state.activeJob.status)) {
      state.sessionEnded = true;
      state.activeJob.cancelRequested = true;
      state.activeJob.updatedAt = Date.now();
      await saveSessionState(dataRoot, sessionId, state);
      return;
    }
    await clearQueuedImages(state, dataRoot, sessionId);
    const resultRoot = path.join(dataRoot, "results", sessionId);
    for (const resultPath of state.resultFiles) {
      const resolved = path.resolve(resultPath);
      if (pathIsWithinRoot(resultRoot, resolved)) {
        await unlink(resolved).catch(() => {});
      }
    }
    await rmdir(resultRoot).catch((error) => {
      if (!(error && typeof error === "object" && ["ENOENT", "ENOTEMPTY"].includes(error.code))) {
        throw error;
      }
    });
    await removeSessionState(dataRoot, sessionId);
  });
}

async function executeCommand(command, context) {
  const config = validateConfig(await loadCommandConfig(context.dataRoot));

  switch (command.kind) {
    case "help":
      return HELP_TEXT;
    case "status": {
      const [health, state, jobStatus] = await Promise.all([
        context.dependencies.getClaudeHealth({ environment: context.environment }),
        readSession(context.dataRoot, context.sessionId),
        context.dependencies.describeClaudeJob(context),
      ]);
      const authorization = state.authorization
        ? `${state.authorization.root}（到期 ${new Date(state.authorization.expiresAt).toLocaleString("zh-CN")}）`
        : "未授权";
      return [
        `Claude Code：${health.installed ? health.version : "未找到"}`,
        `认证：${health.authenticated ? "已登录" : "未登录或无法确认"}`,
        `端点：${health.custom_endpoint ? "自定义 ANTHROPIC_BASE_URL" : "Claude 默认端点"}`,
        `目录：${authorization}`,
        `图片队列：${state.images.length} 张`,
        `后台任务：${jobStatus}`,
        `Claude 会话：${state.claudeSessionId ?? "未持久化"}`,
        `当前 Codex 会话权限覆盖：${state.sessionPermission ?? "无（使用全局默认）"}`,
        "",
        configDisplay(config),
      ].join("\n");
    }
    case "config-show":
      return configDisplay(config);
    case "config-set":
      return withStateLock(context.dataRoot, "global_config", async () => {
        const current = validateConfig(await loadCommandConfig(context.dataRoot));
        const updated = updateConfigValue(current, command.key, command.value);
        await saveCommandConfig(context.dataRoot, updated);
        return `设置已更新。\n${configDisplay(updated)}`;
      });
    case "config-reset":
      return withStateLock(context.dataRoot, "global_config", async () => {
        const current = validateConfig(await loadCommandConfig(context.dataRoot));
        const updated = validateConfig(resetConfigValue(current, command.key));
        await saveCommandConfig(context.dataRoot, updated);
        return `设置已重置。\n${configDisplay(updated)}`;
      });
    case "mode":
      return mutateSession(context.dataRoot, context.sessionId, async (state) => {
        if (command.value === "default") {
          state.sessionPermission = null;
          return `当前 Codex 会话已恢复使用全局默认权限模式：${config.permission}。`;
        }
        if (!Object.hasOwn(PERMISSION_MAP, command.value)) {
          throw new CommandError(`权限模式只能是 default、${PERMISSION_NAMES.join("、")}。`);
        }
        state.sessionPermission = canonicalPermissionName(command.value);
        return `当前 Codex 会话的 Claude 权限模式已设为：${state.sessionPermission}。\n正在运行的任务不改变；后续任务立即使用该模式。`;
      });
    case "access-allow": {
      const requested = command.directory === undefined || command.directory === "."
        ? context.cwd
        : path.resolve(context.cwd, command.directory);
      const authorizedRoot = await normalizeAuthorizationInput({ directory: requested });
      const expiresAt = Date.now() + AUTHORIZATION_TTL_MS;
      await mutateSession(context.dataRoot, context.sessionId, async (state) => {
        if (state.activeJob && ["starting", "running", "waiting"].includes(state.activeJob.status)) {
          throw new CommandError(`Claude Code 任务 ${state.activeJob.id} 正在运行，不能更换授权目录。`);
        }
        const changed = state.authorization && !pathsEqual(state.authorization.root, authorizedRoot);
        state.authorization = { root: authorizedRoot, expiresAt };
        if (changed) {
          state.claudeSessionId = null;
          state.claudeSessionRoot = null;
          state.forkNext = false;
        }
      });
      return `已授权目录：${authorizedRoot}\n授权有效期：4 小时。更换根目录会清除 Claude 恢复会话。`;
    }
    case "access-show": {
      const state = await readSession(context.dataRoot, context.sessionId);
      if (!state.authorization) return "当前任务尚未授权任何目录。";
      return `已授权：${state.authorization.root}\n到期：${new Date(state.authorization.expiresAt).toLocaleString("zh-CN")}`;
    }
    case "access-revoke":
      return mutateSession(context.dataRoot, context.sessionId, async (state) => {
        if (state.activeJob && ["starting", "running", "waiting"].includes(state.activeJob.status)) {
          throw new CommandError(`Claude Code 任务 ${state.activeJob.id} 正在运行；请先取消或等待它结束。`);
        }
        state.authorization = null;
        state.claudeSessionId = null;
        state.claudeSessionRoot = null;
        state.forkNext = false;
        return "目录授权已撤销；Claude 恢复会话已清除。图片队列未删除。";
      });
    case "image-add":
      return mutateSession(context.dataRoot, context.sessionId, async (state) => {
        const added = await addClipboardImages(state, context.dataRoot, context.sessionId, {
          force: command.force,
          captureFunction: context.dependencies.captureClipboard,
          environment: context.environment,
        });
        return `本次加入 ${added.length} 张图片。\n${formatImageQueue(state.images)}`;
      });
    case "image-list": {
      const state = await readSession(context.dataRoot, context.sessionId);
      return formatImageQueue(state.images);
    }
    case "image-clear":
      return mutateSession(context.dataRoot, context.sessionId, async (state) => {
        if (state.activeJob && ["starting", "running", "waiting"].includes(state.activeJob.status)) {
          throw new CommandError("当前有 Claude Code 任务在使用图片队列；请先等待或取消任务，再清空队列。");
        }
        const removed = await clearQueuedImages(state, context.dataRoot, context.sessionId);
        return `已清除 ${removed} 张排队图片。`;
      });
    case "run":
    case "plan":
    case "image-run":
    case "skill-run":
    case "image-skill":
      return stageOrRun(command, context, config);
    case "allow":
    case "deny":
    case "answer":
      return context.dependencies.resolveClaudeApproval(command, context);
    case "cancel":
      return context.dependencies.cancelClaudeJob(command, context);
    case "result":
      return context.dependencies.readClaudeJobResult(context);
    case "plugin-add": {
      const requested = path.resolve(context.cwd, command.value);
      const [normalized] = await normalizePluginDirectories([requested]);
      return withStateLock(context.dataRoot, "global_config", async () => {
        const current = validateConfig(await loadCommandConfig(context.dataRoot));
        if (current.pluginDirectories.some((entry) => pathsEqual(entry, normalized))) {
          return `该插件路径已经存在：${normalized}`;
        }
        const updated = { ...current, pluginDirectories: [...current.pluginDirectories, normalized] };
        await saveCommandConfig(context.dataRoot, updated);
        const activation = updated.customizations === "safe"
          ? "当前 customizations=safe；需改为 plugin-only、user、project 或 all 后才会加载。"
          : "后续 Claude 调用将通过 --plugin-dir 加载。";
        return `已添加 Claude 插件路径：${normalized}\n${activation}`;
      });
    }
    case "plugin-remove": {
      return withStateLock(context.dataRoot, "global_config", async () => {
        const current = validateConfig(await loadCommandConfig(context.dataRoot));
        let index = Number(command.value);
        if (Number.isInteger(index) && index >= 1 && index <= current.pluginDirectories.length) {
          index -= 1;
        } else {
          const requested = path.resolve(context.cwd, command.value);
          index = current.pluginDirectories.findIndex((entry) => pathsEqual(entry, requested));
        }
        if (index < 0 || index >= current.pluginDirectories.length) {
          throw new CommandError("没有找到要移除的插件路径。可先执行 claude plugin list。");
        }
        const removed = current.pluginDirectories[index];
        const updated = {
          ...current,
          pluginDirectories: current.pluginDirectories.filter((_, entryIndex) => entryIndex !== index),
        };
        await saveCommandConfig(context.dataRoot, updated);
        return `已从桥接配置移除：${removed}\n没有删除磁盘上的插件文件，也没有卸载 Claude 的全局插件。`;
      });
    }
    case "plugin-list": {
      const installed = await context.dependencies.getClaudePluginInventory({ environment: context.environment });
      const configured = config.pluginDirectories.length === 0
        ? ["（无）"]
        : config.pluginDirectories.map((entry, index) => `${index + 1}. ${entry}`);
      const installedLines = installed.length === 0
        ? ["（无）"]
        : installed.map((plugin) => `${plugin.id ?? "unknown"} · ${plugin.version ?? "?"} · ${plugin.scope ?? "?"} · ${plugin.enabled ? "enabled" : "disabled"}`);
      return [
        "桥接器显式 --plugin-dir：",
        ...configured,
        "",
        "Claude Code 已安装插件：",
        ...installedLines,
        "",
        `当前 customizations=${config.customizations}。确定性命令使用 Claude 原生工具和权限流程。`,
      ].join("\n");
    }
    case "skill-list": {
      const skills = await discoverSkills(config, context.cwd, context.dependencies);
      return skills.length > 0
        ? `当前可发现的自定义 Skills：\n${skills.map((skill) => `- ${skill}`).join("\n")}\n\nClaude 内置 Skills 不在这个文件扫描列表中，但仍可直接用 skill run 调用。`
        : "没有发现已启用的自定义 Skill。Claude 内置 Skills 仍可直接用 skill run 调用。";
    }
    case "session-show": {
      const state = await readSession(context.dataRoot, context.sessionId);
      return [
        `persist-session: ${config.persistSession ? "on" : "off"}`,
        `session-id: ${state.claudeSessionId ?? "无"}`,
        `bound-root: ${state.claudeSessionRoot ?? "无"}`,
        `fork-next: ${state.forkNext ? "on" : "off"}`,
        `session-permission: ${state.sessionPermission ?? "default"}`,
      ].join("\n");
    }
    case "session-clear":
    case "session-new":
      return mutateSession(context.dataRoot, context.sessionId, async (state) => {
        if (state.activeJob && ["starting", "running", "waiting"].includes(state.activeJob.status)) {
          throw new CommandError(`Claude Code 任务 ${state.activeJob.id} 正在运行；请先等待或取消它，再清除会话。`);
        }
        state.claudeSessionId = null;
        state.claudeSessionRoot = null;
        state.forkNext = false;
        return "桥接器保存的 Claude 会话 ID 已清除；Claude Code 自己的历史文件未删除。";
      });
    case "session-fork":
      return mutateSession(context.dataRoot, context.sessionId, async (state) => {
        if (state.activeJob && ["starting", "running", "waiting"].includes(state.activeJob.status)) {
          throw new CommandError(`Claude Code 任务 ${state.activeJob.id} 正在运行；请先等待或取消它，再设置会话分叉。`);
        }
        if (!state.claudeSessionId) {
          throw new CommandError("当前没有可分叉的 Claude 会话。先启用 persist-session 并成功运行一次。");
        }
        state.forkNext = true;
        return "下一次 Claude 调用将使用 --fork-session；调用后自动复位。";
      });
    default:
      throw new CommandError("尚未实现该命令。");
  }
}

function errorMessage(error) {
  if (error instanceof CommandError || error instanceof InputError) {
    return error.message;
  }
  if (error && typeof error === "object" && typeof error.code === "string") {
    return `${error.message ?? String(error)}（${error.code}）`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function handleHookEvent(input, options = {}) {
  if (!isRecord(input) || typeof input.hook_event_name !== "string") {
    throw new InputError("Hook input must be a JSON object with hook_event_name.");
  }
  const dataRoot = resolvePluginData(options.environment ?? process.env);
  if (input.hook_event_name === "SessionEnd") {
    if (typeof input.session_id === "string") {
      await cleanupSession(dataRoot, input.session_id).catch(() => {});
    }
    return null;
  }
  if (input.hook_event_name !== "UserPromptSubmit") {
    return null;
  }

  let command;
  try {
    command = parseClaudeCommand(input.prompt);
  } catch (error) {
    return { decision: "block", reason: `Codex Claude Code Bridge 命令错误：${errorMessage(error)}` };
  }
  if (command === null) {
    return null;
  }

  if (typeof input.session_id !== "string" || typeof input.cwd !== "string") {
    return { decision: "block", reason: "Codex Claude Code Bridge 缺少当前任务或工作目录信息。" };
  }

  const dependencies = {
    getClaudeHealth: options.getClaudeHealth ?? getClaudeHealth,
    getClaudePluginInventory: options.getClaudePluginInventory ?? getClaudePluginInventory,
    captureClipboard: options.captureClipboard,
    startClaudeJob: options.startClaudeJob ?? startClaudeJob,
    describeClaudeJob: options.describeClaudeJob ?? describeClaudeJob,
    readClaudeJobResult: options.readClaudeJobResult ?? readClaudeJobResult,
    resolveClaudeApproval: options.resolveClaudeApproval ?? resolveClaudeApproval,
    cancelClaudeJob: options.cancelClaudeJob ?? cancelClaudeJob,
  };
  try {
    const reason = await executeCommand(command, {
      dataRoot,
      sessionId: input.session_id,
      cwd: input.cwd,
      transcriptPath: input.transcript_path,
      submittedPrompt: input.prompt,
      environment: options.environment ?? process.env,
      dependencies,
    });
    return { decision: "block", reason };
  } catch (error) {
    return { decision: "block", reason: `Codex Claude Code Bridge 失败：${errorMessage(error)}` };
  }
}
