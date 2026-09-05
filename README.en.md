# Codex Claude Code Bridge

[中文说明](./README.md)

Codex Claude Code Bridge is an unofficial open-source local plugin for Codex or ChatGPT Work. You can control both the Codex and Claude Code agent frameworks from the Codex App, calling Claude Code whenever you need it within the same workflow. With a compatible model provider configured in Claude Code, you can also use other models such as [DeepSeek](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/) and [GLM](https://docs.z.ai/devpack/tool/claude).

Most importantly, the plugin passes the visible conversation context from your current Codex or ChatGPT Work task directly to Claude Code by default. This lets Claude Code reuse the requirements, plans, and progress already discussed for a seamless handoff. In a task with the plugin installed, its hooks trusted, and the project directory authorized, enter `claude run -- ...` when you reach your Codex or ChatGPT Work usage limit and need to switch to Claude Code. Claude Code can continue the work with the existing context, without having to reconstruct the background or copy and paste the conversation.

Enter deterministic `claude` commands in a local Codex or ChatGPT Work task in the Codex App, or in Codex CLI. The hook intercepts the command before the host model starts and invokes the local Claude Code CLI, so continuing a task does not require the Codex or ChatGPT Work model to interpret or relay the request first. Runtime approvals use Claude's official `--permission-prompt-tool` interface. Safe mode uses the bidirectional stdio control protocol; other modes retain the MCP approval channel.

The plugin supports visible Codex or ChatGPT Work conversation inheritance, a private multi-image Windows clipboard queue, Claude Code backend models and effort levels, all six native permission modes, per-tool runtime approvals, Claude Skills/plugins/hooks/MCP, and resumable sessions.

The project is not affiliated with or endorsed by OpenAI or Anthropic. It does not bundle Claude Code, an account, a subscription, or an API key.

> `claude ...` is the plugin hook command shared by Codex App and CLI, not a built-in Codex or ChatGPT Work command. The App also accepts `/claude ...`; Codex CLI rejects unknown built-in slash commands before hooks run, so CLI users must omit `/`. Once the hook is installed and trusted, supported direct commands do not go through the Codex or ChatGPT Work model.

## Support scope

The complete plugin targets local Codex or ChatGPT Work desktop tasks with local plugin, hook, and transcript support, as well as Codex CLI. It depends on a `.codex-plugin` manifest, Codex `UserPromptSubmit`/`Interrupt`/`SessionEnd` hooks, task-scoped `PLUGIN_DATA`, `transcript_path`, and a Codex Skill, so another agent cannot install it as a feature-equivalent plugin. References to ChatGPT Work here mean desktop environments that provide these local capabilities; web and cloud-only tasks are outside the complete plugin's support scope. See the [OpenAI plugin documentation](https://learn.chatgpt.com/docs/plugins) for the host's plugin mechanism.

Other agents with local stdio MCP support may manually configure the server in `.mcp.json` and reuse the four conservative tools: `claude_code_health`, `claude_code_authorize_directory`, `claude_code_plan`, and `claude_code_run`. That limited MCP reuse does not include deterministic `claude` commands, Codex or ChatGPT Work conversation inheritance, task cleanup, the clipboard image queue, or native runtime approvals and is not a supported equivalent of the complete product.

## Quick start

```text
claude access allow .
claude status
claude run -- Summarize this project
```

The default `manual` mode starts Claude immediately. It pauses only when Claude reaches a real tool permission request that native rules and the selected mode have not already resolved:

```text
claude allow a1b2c3d4 once
```

The same background Claude process and tool call continue from the paused point. The task is not restarted.

`plan`, `run`, `image run`, and `skill run` normally wait until Claude Code has a final result and return it once from the current hook. They no longer fall back to manual polling after a fixed 30-second window. The detached worker remains in place for real approvals, Codex or ChatGPT Work task interruption, hook timeouts, and safe cleanup after an unexpected App exit.

## Codex App: Codex or ChatGPT Work

1. Install and enable the plugin.
2. Open **Settings → Hooks** and review the plugin's `UserPromptSubmit`, `Interrupt`, and `SessionEnd` hooks. Verify that the source is `codex-claude-code-bridge@personal` and that the command only starts this plugin's `scripts/command-hook.mjs`, then trust it.
3. Fully quit and reopen the Codex App, then create a new local Codex or ChatGPT Work task in the target project.
4. Send `/claude status` or `claude status`. A hook-produced Claude status means interception is active.

The App's plugin picker or `@` mention displays the plugin name above the composer. That is useful for the natural-language MCP/Skill fallback. Deterministic `claude ...` messages and the App's `/claude ...` alias do not need the plugin label on every request and do not require selecting the plugin first.

For both initial installation and updates marked `new or changed`, you can review and trust the hooks in **Settings → Hooks** in the Codex App. You can also complete the same review with `/hooks` in Codex CLI.

## Codex CLI

1. Run `codex`.
2. Use `/plugins` to confirm the plugin is installed and enabled.
3. Use `/hooks` to review and trust its `UserPromptSubmit`, `Interrupt`, and `SessionEnd` hooks.
4. Start a fresh CLI session.
5. Send `claude status`, then `claude access allow .`. Do not add `/`: the CLI treats it as an unknown built-in slash command and rejects it before the hook receives the prompt.

Subcommands, arguments, and behavior are otherwise identical. CLI uses `claude ...`; the App accepts both forms.

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

Global default, current Codex or ChatGPT Work task override, and one-run override:

```text
claude config set permission manual
claude mode accept-edits
claude mode default
claude run --permission plan -- Analyze the implementation first
claude run --permission bypass -- Build and test the project
```

`image run`, `skill run`, and `image skill` accept the same `--permission` option.

### Exact bypass behavior

`bypass` passes `--permission-mode bypassPermissions` and Claude's required explicit dangerous-mode acknowledgement. The bridge adds no fixed tool list, Bash/PowerShell denial, web denial, MCP/plugin denial, or filesystem sandbox. `claude access allow .` confirms the launch root and binds resumed sessions; it is not OS isolation. Claude runs as the current Windows user.

Claude's own hooks, policy settings, ask/deny rules, critical-path protections, and cross-session safeguards still apply. If managed policy disables bypass, the bridge reports Claude's error and does not work around it.

## Runtime approvals

The detached worker keeps the same Claude process alive while the permission-prompt MCP tool waits:

```text
claude allow <id> once
claude allow <id> session
claude allow <id> project
claude allow <id> user
claude deny <id> -- Do not delete files; archive them instead
claude answer <id> -- {"Which database?":"SQLite"}
```

`session`, `project`, and `user` echo matching native permission suggestions supplied by Claude when available. `project` prefers local/project settings destinations. `AskUserQuestion` requests display question JSON and use `claude answer`.

Normal tasks wait synchronously for the final result within `timeout-seconds`. A command returns before a terminal state only when Claude is waiting for a real tool approval or `AskUserQuestion`, the Codex or ChatGPT Work turn is interrupted, or the worker still cannot write a terminal state during the hook's finalization grace period after Claude's timeout. After `allow`, `deny`, or `answer`, the bridge waits on the same Claude process until its final result or next approval.

The stop action in a local Codex or ChatGPT Work task invokes the `Interrupt` hook and cancels the worker. These commands are primarily for recovery between approvals, after an unexpected hook/App exit, or for an explicit cancellation; they are no longer required for normal calls:

```text
claude status
claude result
claude cancel <job-id>
```

If duplicate hook instances receive the same `turn_id` for a Codex or ChatGPT Work task concurrently, the command executes once and the other instances exit silently, so one submission does not create duplicate results.

Once cancellation is requested, old approvals are no longer offered: the command waits for termination or explicitly reports cancellation in progress. `deny` rejects one tool call and returns its reason to Claude; it does not create a permanent deny rule. Use `cancel` to stop the task. After a normal result has been delivered, `result` is not a history lookup and never reruns the task.

## Codex or ChatGPT Work conversation inheritance

`run`, `plan`, `image run`, and `skill run` read the hook's `transcript_path` by default, extract visible user messages and assistant replies from the current Codex or ChatGPT Work task, and place the current request first for Claude Code. You can ask Claude Code to continue the unfinished work using that context:

```text
claude run -- Use the requirements, plans, and progress discussed above, inspect the current project state, and continue the unfinished work.
```

This deterministic command does not require a Codex or ChatGPT Work model call first, making it useful when you reach a usage limit. Inheritance covers visible conversation text from the transcript; long conversations retain the beginning and most recent content within the length limit. Raw tool logs, hidden reasoning, and credentials are not intentionally extracted.

```text
claude config set conversation-context off
claude config set conversation-context on
```

The bridge also retains the current request and final Claude response in the same task. The next ordinary Codex message receives undelivered exchanges through the hook's `additionalContext`; subsequent Claude calls receive the same authorized project's bridge history. Exchanges identify their source and completed, failed, or cancelled status and are historical data, not new instructions or permissions. A result is not injected on every ordinary message.

History retains at most 10 calls with total and per-entry text limits and explicit truncation markers. Clearing the Claude session, changing or revoking the authorized root, or ending the task clears this history. Old hook-only responses from before the update are not imported automatically.

`conversation-context off` pauses future context transfer in both directions without deleting stored history; re-enabling it permits transfer again. It cannot retract context already delivered to a model. Conversation text can still contain secrets, proprietary material, or prompt injection.

## Direct multi-image handoff

The Codex hook does not expose pixels from unsubmitted attachments. The bridge captures the original bitmap or image files from the Windows clipboard without requiring a manual save.

The Codex App adds a file list and a `My request` envelope to submissions with attachments. The bridge recognizes only the explicit user request inside that envelope. `claude` or `/claude` text in attachment names, document contents, or any other envelope section never triggers a command.

For each copied or pasted bitmap, send `claude image add`; a clipboard containing multiple image files adds them together. Then:

```text
claude image list
claude image run [--permission <mode>] -- Compare every image
claude image skill <skill> [--permission <mode>] -- [arguments]
claude image clear
```

Images are delivered in queue order and removed after the consuming task completes or fails.

## Configuration, plugins, and Skills

```text
claude config show
claude config set model opus
claude config set model opus[1m]
claude config set effort high
claude config set permission manual
claude config set customizations all
claude config set timeout-seconds 1800
claude config set max-budget-usd off
claude config set persist-session on
claude config set conversation-context on
claude config reset [key|all]
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
claude plugin list
claude plugin add "C:\absolute\path\my-plugin"
claude plugin remove <index|absolute-path>
claude skill list
claude skill run my-plugin:review -- Check permission boundaries
```

Loaded hooks, plugins, and MCP servers can run local code or external actions. Their behavior is governed by Claude's native permission flow.

## Claude sessions

```text
claude config set persist-session on
claude session show
claude session clear
claude session fork
```

Successful calls retain the Claude session ID and can resume inside the same authorized root. `session fork` forks the next resumed call.

`persist-session` controls automatic Claude session resumption. When off, each call still starts a new Claude session. If user, project, or explicit plugin customizations are loaded, native Claude session files remain enabled for hooks that read `transcript_path`; this does not resume an earlier session. With `safe`, or `plugin-only` without explicit plugins, turning resumption off also disables native session files. The `native_session_files` metadata reports the effective behavior.

## Deterministic and model-directed paths

The deterministic hook path handles `claude` before Codex or ChatGPT Work model inference, with `/claude` retained as an App alias. The current Codex hook response API cannot create a normal assistant bubble, so results appear as hook-block messages.

A guarded MCP server and Codex Skill remain available when the user explicitly asks Codex or ChatGPT Work to coordinate Claude Code. This path requires the host model; use the deterministic `claude` commands above when you reach the host's usage limit. The MCP fallback keeps its separate directory capability and conservative tool surface; it is not the direct command path and does not automatically enable bypass.

## Known boundaries and troubleshooting

- Claude Code can occasionally return a successful envelope with an empty final `result`, especially when user or project customizations are loaded. Deterministic commands use `stream-json` and first recover the last non-empty main-session assistant text. If both the final envelope and assistant stream are empty, the bridge reports turn count, cost, loaded plugins, and stream event counts, and it does not retry automatically. For one low-cost isolation run, set `customizations` to `plugin-only` or `safe`, set a small `max-budget-usd`, and then inspect Claude hooks, plugins, and settings.
- If an empty final envelope follows Stop hook failures and multiple main-session replies, recovery preserves those replies in order instead of losing the original answer to a short final repetition. `hook_failures` identifies failures and missing transcripts. The bridge keeps native transcripts for customizations to avoid the missing-file Stop loop observed with claude-mem.
- The inherited Codex or ChatGPT Work conversation is supplied to Claude as user context. Claude may identify content in it as prompt injection and refuse the request. Use `claude config set conversation-context off` and retry with a self-contained prompt when appropriate.
- Non-interactive `codex exec` can currently report only that a hook blocked the request without printing the complete hook reason. Review hook trust in **Settings → Hooks** in the Codex App or with `/hooks` in interactive Codex CLI; do not use non-interactive `codex exec` for troubleshooting.
- Claude Code enforces `max-budget-usd` natively and may stop only after an already-started API turn finishes, so actual cost can slightly exceed the configured value. It is not a prepaid hard cutoff.
- `claude status` reports whether the current process has a custom `ANTHROPIC_BASE_URL` without exposing the URL. If authentication looks healthy but a call remains `running`, run the native Claude CLI command `claude doctor` in a system terminal to inspect the installation (it is not a bridge chat command). The bridge respects Claude's environment and does not override a custom endpoint.
- `plugin-only` does not load environment variables from Claude user settings. If the inherited `ANTHROPIC_BASE_URL` differs from the address in those settings, switching modes may cause a model 404. Ensure the environment launching Codex points to the intended service; the bridge does not copy user settings to override this isolation.

## Install

Requirements:

- a Codex or ChatGPT Work desktop environment with local plugin, hook, and transcript support, or Codex CLI;
- Node.js 18 or newer;
- Windows PowerShell 5.1+ for clipboard capture;
- a locally installed and authenticated Claude Code CLI, verified with `2.1.259`;
- npm for project scripts; runtime code has no third-party npm dependency.

```powershell
git clone https://github.com/yeyiwen2006/codex-claude-code-bridge.git
cd codex-claude-code-bridge
npm install
npm run check
node .\scripts\register-personal-marketplace.mjs
codex plugin add codex-claude-code-bridge@personal
```

Start a new local Codex or ChatGPT Work task after every install or update. Whenever the host marks a hook `new or changed`, re-review it in **Settings → Hooks** in the App or with `/hooks` in Codex CLI. This release adds `Interrupt` and extends the `UserPromptSubmit` synchronous wait, so an updated installation must be reviewed again.

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

The project can be published as a normal public GitHub repository. It contains no user login credentials, clipboard images, runtime state, or project data. Each user must install Claude Code, Node.js, and a Codex or ChatGPT Work environment with local plugin support, and trust the hook independently.

The automated suite covers App/CLI command parsing, one-turn deduplication, synchronous completion, delayed jobs, timeout, interrupt cancellation, tool approvals, `AskUserQuestion`, empty-result recovery, customization isolation, conversation inheritance, image ordering, permission modes, MCP, and UTF-8 validation.

This local project is not a generic OpenAI cloud plugin: it depends on local stdio MCP, Codex hooks, the Windows clipboard, and local processes.

## License

This project is licensed under the [MIT License](./LICENSE). Copyright © 2026 Yiwen Ye (GitHub: [@yeyiwen2006](https://github.com/yeyiwen2006)).
