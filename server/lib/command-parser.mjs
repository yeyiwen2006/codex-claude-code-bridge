export class CommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandError";
  }
}

function tokenizeWithPositions(text) {
  const tokens = [];
  let value = "";
  let start = -1;
  let quote = null;

  const finish = (end) => {
    if (start >= 0) {
      tokens.push({ value, start, end });
      value = "";
      start = -1;
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
        continue;
      }
      if (character === "\\" && (text[index + 1] === quote || text[index + 1] === "\\")) {
        value += text[index + 1];
        index += 1;
        continue;
      }
      value += character;
      continue;
    }

    if (/\s/.test(character)) {
      finish(index);
      continue;
    }
    if (start < 0) {
      start = index;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    value += character;
  }

  if (quote !== null) {
    throw new CommandError("命令中存在未闭合的引号。");
  }
  finish(text.length);
  return tokens;
}

function parseBody(body) {
  const tokenRecords = tokenizeWithPositions(body);
  const separatorIndex = tokenRecords.findIndex((token) => token.value === "--");
  if (separatorIndex < 0) {
    return { tokens: tokenRecords.map((token) => token.value), prompt: undefined };
  }
  const separator = tokenRecords[separatorIndex];
  return {
    tokens: tokenRecords.slice(0, separatorIndex).map((token) => token.value),
    prompt: body.slice(separator.end).trimStart(),
  };
}

function expectArity(tokens, minimum, maximum, usage) {
  if (tokens.length < minimum || tokens.length > maximum) {
    throw new CommandError(`用法：${usage}`);
  }
}

function requirePrompt(prompt, usage) {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new CommandError(`用法：${usage}`);
  }
  return prompt;
}

function requireNoPrompt(prompt, usage) {
  if (prompt !== undefined) {
    throw new CommandError(`此命令不接受 -- 后的提示词。用法：${usage}`);
  }
}

export function parseClaudeCommand(rawPrompt) {
  if (typeof rawPrompt !== "string") {
    return null;
  }
  const leadingTrimmed = rawPrompt.trimStart();
  if (!leadingTrimmed.startsWith("/claude")) {
    return null;
  }
  const afterPrefix = leadingTrimmed.slice("/claude".length);
  if (afterPrefix.length > 0 && !/^\s/.test(afterPrefix)) {
    return null;
  }

  const { tokens, prompt } = parseBody(afterPrefix.trimStart());
  if (tokens.length === 0) {
    requireNoPrompt(prompt, "/claude help");
    return { kind: "help" };
  }

  const [group, action, ...rest] = tokens;
  if (group === "help") {
    expectArity(tokens, 1, 1, "/claude help");
    requireNoPrompt(prompt, "/claude help");
    return { kind: "help" };
  }
  if (group === "status") {
    expectArity(tokens, 1, 1, "/claude status");
    requireNoPrompt(prompt, "/claude status");
    return { kind: "status" };
  }
  if (group === "run" || group === "plan") {
    expectArity(tokens, 1, 1, `/claude ${group} -- <提示词>`);
    return { kind: group, prompt: requirePrompt(prompt, `/claude ${group} -- <提示词>`) };
  }
  if (group === "approve" || group === "cancel") {
    expectArity(tokens, 2, 2, `/claude ${group} <审批 ID>`);
    requireNoPrompt(prompt, `/claude ${group} <审批 ID>`);
    if (!/^[0-9a-f]{8}$/i.test(action)) {
      throw new CommandError("审批 ID 必须是插件返回的 8 位十六进制 ID。");
    }
    return { kind: group, approvalId: action.toLowerCase() };
  }

  if (group === "config") {
    requireNoPrompt(prompt, "/claude config show|set|reset ...");
    if (action === "show") {
      expectArity(tokens, 2, 2, "/claude config show");
      return { kind: "config-show" };
    }
    if (action === "set") {
      expectArity(tokens, 4, 4, "/claude config set <键> <值>");
      if (rest[0].length === 0 || rest[1].length === 0) {
        throw new CommandError("配置键和值不能为空。");
      }
      return { kind: "config-set", key: rest[0], value: rest[1] };
    }
    if (action === "reset") {
      expectArity(tokens, 2, 3, "/claude config reset [键|all]");
      return { kind: "config-reset", key: rest[0] ?? "all" };
    }
    throw new CommandError("用法：/claude config show|set|reset ...");
  }

  if (group === "access") {
    requireNoPrompt(prompt, "/claude access show|allow|revoke ...");
    if (action === "show" || action === "revoke") {
      expectArity(tokens, 2, 2, `/claude access ${action}`);
      return { kind: `access-${action}` };
    }
    if (action === "allow") {
      expectArity(tokens, 2, 3, "/claude access allow [绝对路径|.]");
      if (rest[0] !== undefined && rest[0].length === 0) {
        throw new CommandError("授权路径不能为空。");
      }
      return { kind: "access-allow", directory: rest[0] };
    }
    throw new CommandError("用法：/claude access show|allow|revoke ...");
  }

  if (group === "image") {
    if (action === "add") {
      requireNoPrompt(prompt, "/claude image add [--force]");
      expectArity(tokens, 2, 3, "/claude image add [--force]");
      if (rest.length > 0 && rest[0] !== "--force") {
        throw new CommandError("image add 只支持可选参数 --force。");
      }
      return { kind: "image-add", force: rest[0] === "--force" };
    }
    if (action === "list" || action === "clear") {
      expectArity(tokens, 2, 2, `/claude image ${action}`);
      requireNoPrompt(prompt, `/claude image ${action}`);
      return { kind: `image-${action}` };
    }
    if (action === "run") {
      expectArity(tokens, 2, 2, "/claude image run -- <提示词>");
      return { kind: "image-run", prompt: requirePrompt(prompt, "/claude image run -- <提示词>") };
    }
    if (action === "skill") {
      expectArity(tokens, 3, 3, "/claude image skill <Skill 名称> -- [参数]");
      return { kind: "image-skill", skill: rest[0], prompt: prompt ?? "" };
    }
    throw new CommandError("用法：/claude image add|list|clear|run|skill ...");
  }

  if (group === "plugin") {
    requireNoPrompt(prompt, "/claude plugin list|add|remove ...");
    if (action === "list") {
      expectArity(tokens, 2, 2, "/claude plugin list");
      return { kind: "plugin-list" };
    }
    if (action === "add" || action === "remove") {
      expectArity(tokens, 3, 3, `/claude plugin ${action} <绝对路径|序号>`);
      if (rest[0].length === 0) {
        throw new CommandError("插件路径或序号不能为空。");
      }
      return { kind: `plugin-${action}`, value: rest[0] };
    }
    throw new CommandError("用法：/claude plugin list|add|remove ...");
  }

  if (group === "skill") {
    if (action === "list") {
      expectArity(tokens, 2, 2, "/claude skill list");
      requireNoPrompt(prompt, "/claude skill list");
      return { kind: "skill-list" };
    }
    if (action === "run") {
      expectArity(tokens, 3, 3, "/claude skill run <Skill 名称> -- [参数]");
      return { kind: "skill-run", skill: rest[0], prompt: prompt ?? "" };
    }
    throw new CommandError("用法：/claude skill list|run ...");
  }

  if (group === "session") {
    requireNoPrompt(prompt, "/claude session show|new|clear|fork");
    if (!["show", "new", "clear", "fork"].includes(action)) {
      throw new CommandError("用法：/claude session show|new|clear|fork");
    }
    expectArity(tokens, 2, 2, `/claude session ${action}`);
    return { kind: `session-${action}` };
  }

  throw new CommandError("未知的 /claude 命令。输入 /claude help 查看可用命令。");
}

export function validateSkillName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(name)) {
    throw new CommandError("Skill 名称只能包含字母、数字、冒号、下划线和连字符。");
  }
  return name;
}
