# Codex Claude Code Bridge

[中文说明](./README.md)

Codex Claude Code Bridge is an unofficial open-source local Codex plugin. It intercepts deterministic `/claude` messages before the Codex model starts and invokes the local Claude Code CLI. Runtime approvals use Claude's official `--permission-prompt-tool` MCP interface. It supports visible Codex conversation inheritance, a private multi-image Windows clipboard queue, models and effort levels, all six native permission modes, per-tool runtime approvals, Claude Skills/plugins/hooks/MCP, and resumable sessions.

The project is not affiliated with or endorsed by OpenAI or Anthropic. It does not bundle Claude Code, an account, a subscription, or an API key.

> `/claude ...` is a plugin hook command, not a built-in Codex slash command. Once the hook is installed and trusted, Codex does not interpret it with a model.

## Support scope

The complete plugin supports Codex App and Codex CLI only. It depends on a `.codex-plugin` manifest, Codex `UserPromptSubmit`/`SessionEnd` hooks, task-scoped `PLUGIN_DATA`, `transcript_path`, and a Codex Skill, so another agent cannot install it as a feature-equivalent plugin.

Other agents with local stdio MCP support may manually configure the server in `.mcp.json` and reuse the four conservative tools: `claude_code_health`, `claude_code_authorize_directory`, `claude_code_plan`, and `claude_code_run`. That limited MCP reuse does not include `/claude`, Codex conversation inheritance, task cleanup, the clipboard image queue, or native runtime approvals and is not a supported equivalent of the complete product.

## Quick start

```text
/claude access allow .
/claude status
/claude run -- Summarize this project
```

The default `manual` mode starts Claude immediately. It pauses only when Claude reaches a real tool permission request that native rules and the selected mode have not already resolved:

```text
/claude allow a1b2c3d4 once
```

The same background Claude process and tool call continue from the paused point. The task is not restarted.

## Codex App

1. Install and enable the plugin, then fully quit the Codex App.
2. Open PowerShell and run `codex`.
3. At `Hooks need review`, choose `Review hooks`. Verify the source is `codex-claude-code-bridge@personal` and the command only starts this plugin's `scripts/command-hook.mjs`, then trust it.
4. If CLI is already open, use `/hooks` for the same review. Do not continue without trusting the hook.
5. Exit CLI, reopen the App, and create a new task in the target project.
6. Send `/claude status`. A hook-produced Claude status means interception is active.

The App's plugin picker or `@` mention displays the plugin name above the composer. That is useful for the natural-language MCP/Skill fallback. Deterministic `/claude ...` messages do not need the plugin label on every request and do not require selecting the plugin first.

The App does not currently expose `/hooks`. Initial trust, and re-trust after an update is marked `new or changed`, must be completed once in Codex CLI. Reopen the App and start a new task afterward.

## Codex CLI

1. Run `codex`.
2. Use `/plugins` to confirm the plugin is installed and enabled.
3. Use `/hooks` to review and trust its `UserPromptSubmit` and `SessionEnd` hooks.
4. Start a fresh CLI session.
5. Send `/claude status`, then `/claude access allow .`.

The remaining commands are identical in App and CLI.

## Native permission modes

The bridge preserves Claude's native permission evaluation: hooks, deny rules, ask rules, the active permission mode, allow rules, and the runtime approval callback.

| Bridge name | Native mode | Behavior |
| --- | --- | --- |
| `manual` | `manual` | No unmatched tool is pre-approved; real permission requests pause for the user |
| `accept-edits` | `acceptEdits` | Native file-edit/filesystem actions are approved; other unmatched tools can prompt |
| `plan` | `plan` | Native planning mode; writes are not auto-approved |
| `auto` | `auto` | Claude's classifier allows or denies prompts when supported by account and policy |
| `dont-ask` | `dontAsk` | Anything not pre-approved is denied without prompting |
| `bypass` | `bypassPermissions` | Bypasses ordinary permission prompts and exposes Claude's full tool surface |

Global default, current-Codex-task override, and one-run override:

```text
/claude config set permission manual
/claude mode accept-edits
/claude mode default
/claude run --permission plan -- Analyze the implementation first
/claude run --permission bypass -- Build and test the project
```

`image run`, `skill run`, and `image skill` accept the same `--permission` option.

### Exact bypass behavior

`bypass` passes `--permission-mode bypassPermissions` and Claude's required explicit dangerous-mode acknowledgement. The bridge adds no fixed tool list, Bash/PowerShell denial, web denial, MCP/plugin denial, or filesystem sandbox. `/claude access allow .` confirms the launch root and binds resumed sessions; it is not OS isolation. Claude runs as the current Windows user.

Claude's own hooks, policy settings, ask/deny rules, critical-path protections, and cross-session safeguards still apply. If managed policy disables bypass, the bridge reports Claude's error and does not work around it.

## Runtime approvals

The detached worker keeps the same Claude process alive while the permission-prompt MCP tool waits:

```text
/claude allow <id> once
/claude allow <id> session
/claude allow <id> project
/claude allow <id> user
/claude deny <id> -- Do not delete files; archive them instead
/claude answer <id> -- {"Which database?":"SQLite"}
```

`session`, `project`, and `user` echo matching native permission suggestions supplied by Claude when available. `project` prefers local/project settings destinations. `AskUserQuestion` requests display question JSON and use `/claude answer`.

For a long-running background task:

```text
/claude status
/claude result
/claude cancel <job-id>
```

## Codex conversation inheritance

`run`, `plan`, `image run`, and `skill run` read the hook's `transcript_path` by default, extract visible user messages and final Codex replies, and place the current task first. Raw tool logs, hidden reasoning, and credentials are not intentionally extracted.

```text
/claude config set conversation-context off
/claude config set conversation-context on
```

Conversation text can still contain secrets, proprietary material, or prompt injection.

## Direct multi-image handoff

The Codex hook does not expose pixels from unsubmitted attachments. The bridge captures the original bitmap or image files from the Windows clipboard without requiring a manual save.

For each copied or pasted bitmap, send `/claude image add`; a clipboard containing multiple image files adds them together. Then:

```text
/claude image list
/claude image run [--permission <mode>] -- Compare every image
/claude image skill <skill> [--permission <mode>] -- [arguments]
/claude image clear
```

Images are delivered in queue order and removed after the consuming task completes or fails.

## Configuration, plugins, and Skills

```text
/claude config show
/claude config set model opus
/claude config set effort high
/claude config set permission manual
/claude config set customizations all
/claude config set timeout-seconds 1800
/claude config set max-budget-usd off
/claude config set persist-session on
/claude config set conversation-context on
/claude config reset [key|all]
```

| `customizations` | Behavior |
| --- | --- |
| `safe` | Load no user/project/local settings; useful for troubleshooting |
| `plugin-only` | Load only local plugins explicitly added through the bridge |
| `user` | Load user settings, Skills, plugins, hooks, and MCP |
| `project` | Load project/local settings, CLAUDE.md, Skills, plugins, hooks, and MCP |
| `all` | Omit `--setting-sources` and use the native Claude CLI default cascade |

New installs default to `all`, so normal Claude Code Skills, hooks, plugins, and MCP remain available.

```text
/claude plugin list
/claude plugin add "C:\absolute\path\my-plugin"
/claude plugin remove <index|absolute-path>
/claude skill list
/claude skill run my-plugin:review -- Check permission boundaries
```

Loaded hooks, plugins, and MCP servers can run local code or external actions. Their behavior is governed by Claude's native permission flow.

## Claude sessions

```text
/claude config set persist-session on
/claude session show
/claude session clear
/claude session fork
```

Successful calls retain the Claude session ID and can resume inside the same authorized root. `session fork` forks the next resumed call.

## Deterministic and model-directed paths

The deterministic hook path handles `/claude` before Codex model inference. Codex's current hook response API cannot create a normal assistant bubble, so results appear as hook-block messages.

A guarded MCP server and Codex Skill remain available when the user explicitly asks Codex to coordinate Claude. That MCP fallback keeps its separate directory capability and conservative tool surface; it is not the direct command path and does not automatically enable bypass.

## Known boundaries and troubleshooting

- Claude Code can occasionally return a successful envelope with an empty result, especially when user or project customizations are loaded. The bridge preserves exit code, protocol warning, stop reason, and related diagnostic metadata. First retry with `/claude config set customizations plugin-only`, then inspect Claude hooks, plugins, and settings.
- The inherited Codex conversation is supplied to Claude as user context. Claude may identify content in it as prompt injection and refuse the request. Use `/claude config set conversation-context off` and retry with a self-contained prompt when appropriate.
- Non-interactive `codex exec` can currently report only that a hook blocked the request without printing the complete hook reason. Use interactive `codex` for first-time hook trust and troubleshooting.
- Claude Code enforces `max-budget-usd` natively and may stop only after an already-started API turn finishes, so actual cost can slightly exceed the configured value. It is not a prepaid hard cutoff.

## Install

Requirements:

- Codex with local plugin and hook support;
- Node.js 18 or newer;
- Windows PowerShell 5.1+ for clipboard capture;
- a locally installed and authenticated Claude Code CLI, verified with `2.1.258`;
- npm for project scripts; runtime code has no third-party npm dependency.

```powershell
git clone https://github.com/yeyiwen2006/codex-claude-code-bridge.git
cd codex-claude-code-bridge
npm install
npm run check
node .\scripts\register-personal-marketplace.mjs
codex plugin add codex-claude-code-bridge@personal
```

Start a new Codex task after every install or update. Re-review the hook in CLI whenever Codex marks it `new or changed`.

## Security and data

- Claude runs under the current Windows user. The plugin is not a VM, container, or OS sandbox.
- `manual` approves the actual tool request, not a whole task batch.
- `bypass` may modify or delete data outside the project and call external plugins/MCP/network services with the current user's capabilities.
- Prompts, inherited conversation, image paths, and job state are stored locally under plugin data. Model requests and enabled external tools can send data off the machine.
- The plugin does not log Claude credentials. The background CLI uses normal Claude Code environment and authentication sources.
- See [SECURITY.md](./SECURITY.md) for the detailed threat model.

## Development and publishing

```powershell
npm install
npm run check
```

The project can be published as a normal public GitHub repository. It contains no user login credentials, clipboard images, runtime state, or project data. Each user must install Claude Code, Node.js, and Codex locally and trust the hook independently.

This local project is not a generic OpenAI cloud plugin: it depends on local stdio MCP, Codex hooks, the Windows clipboard, and local processes.

## License

MIT. See [LICENSE](./LICENSE).
