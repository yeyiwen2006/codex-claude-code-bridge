# Security policy

## Supported versions

Security fixes are applied to the latest published version.

## Reporting a vulnerability

Do not open a public issue containing credentials, private prompts, proprietary source, or exploit details. Contact the maintainer privately and include the affected version, platform, reproduction steps, impact, and any proposed mitigation.

## Trust boundaries

Codex Claude Code Bridge runs locally under the current operating-system user. It is not a VM, container, Windows security boundary, or network sandbox.

There are two distinct execution paths:

- Deterministic `/claude` hook commands use the local Claude Code CLI and its official `--permission-prompt-tool` MCP interface. Their permissions follow Claude's native modes and runtime permission flow.
- The optional model-directed Codex MCP fallback retains its own temporary directory capability and conservative tool list. It does not silently inherit direct-command bypass behavior.

`/claude access allow <directory>` confirms the launch root, binds resumable Claude sessions to that root, and prevents accidental execution in a different Codex project. It does not stop Bash, plugins, MCP servers, or other tools from reaching paths that the current user can access when Claude's own permission flow allows them.

## Native permission modes

The deterministic path supports all current Claude modes:

- `manual` passes Claude Code's native `manual` mode and pauses only for real permission requests not already resolved by hooks, rules, or mode behavior.
- `accept-edits` maps to `acceptEdits`.
- `plan` maps to `plan`.
- `auto` maps to `auto` and depends on Claude/account availability.
- `dont-ask` maps to `dontAsk` and denies unresolved prompts.
- `bypass` maps to `bypassPermissions` with Claude's required explicit dangerous-mode acknowledgement.

The bridge does not add an entire-task approval before Claude starts. A detached worker keeps the same Claude process alive while a specific tool request waits in the permission-prompt MCP server. `/claude allow` or `/claude deny` resolves that request, and execution resumes from the same tool call.

Claude evaluates hooks, managed settings, deny rules, ask rules, its permission mode, allow rules, and residual safeguards. The bridge does not circumvent organization policy or Claude errors.

## Bypass mode

Bypass is intentionally available because Claude Code exposes it natively. In this mode the deterministic bridge does not impose a fixed tools list, deny Bash or PowerShell, deny web access, deny Claude plugin/MCP tools, or confine filesystem access to the launch root.

Consequences include:

- Claude can execute commands and start processes as the current user.
- Claude can read, modify, or delete data outside the project when the current user can do so.
- Claude can access the network and invoke enabled third-party MCP servers, plugins, Skills, and Hooks.
- Subagents can inherit powerful permission modes according to Claude's native behavior.
- Project content, inherited conversation, image text, tool output, Skills, plugins, or MCP responses may contain prompt injection that leads to harmful actions.

Use bypass only when the project, loaded customizations, and intended operations are trusted. Prefer `manual`, `accept-edits`, or `plan` for ordinary work.

Claude's residual safeguards still apply. Examples can include explicit ask/deny policy rules, managed settings, Hooks, interactive tools, connector policy, critical-path deletion protection, and cross-session restrictions. Their exact behavior is version- and policy-dependent.

## Runtime approval state

Global settings and per-Codex-task state are stored as UTF-8 JSON under `PLUGIN_DATA`. State can contain directory authorization, queued-image metadata, Claude session IDs, a background job ID, and one current permission request summary.

The complete task specification is written to a private per-job JSON file before the worker starts and deleted when the worker ends. It can contain the prompt, inherited conversation snapshot, configuration snapshot, image paths, and authorization root. The actual tool input remains in the worker's memory; a bounded display copy is placed in state so the user can make a decision.

Claude results are stored as private UTF-8 Markdown files until consumed or the Codex task is cleaned up. The state files and result files are application-private data, not encrypted vaults. Any process running as the same OS user may be able to read them.

## Approval scopes

`once` approves only the current callback. `session`, `project`, and `user` return matching permission-update suggestions supplied by Claude when available. These suggestions may update in-memory session rules or Claude settings files. Review the displayed tool and intended scope before choosing a persistent option.

`/claude answer` passes an answer object to Claude's `AskUserQuestion` call. Question text and answers are treated as user data and may be sent to the model.

## Clipboard images

The bridge reads the Windows clipboard only after an explicit `/claude image add`. It copies supported PNG, JPEG, GIF, and WebP data into the plugin data directory, validates the captured bytes, and preserves queue order. It does not continuously monitor the clipboard.

Queued images remain local until a Claude task is run, at which point Claude Code reads the private image paths. The model and any enabled external tools may receive information extracted from the images. Clear the queue before switching to unrelated sensitive work.

## Codex conversation inheritance

When enabled, the bridge reads the current Codex transcript path supplied by the hook and extracts visible user messages and final assistant responses. It does not intentionally include hidden reasoning or raw tool logs, but visible content can still contain secrets, proprietary material, malicious instructions, or incorrect statements.

Use `/claude config set conversation-context off` before a task when the current Codex conversation should not be disclosed to Claude.

## Claude customizations

`customizations=all` uses Claude's normal user, project, and local settings cascade and is the default for new installs. Loaded CLAUDE.md files, Skills, Hooks, plugins, MCP servers, and settings are trusted Claude inputs and code. They may execute local programs, use credentials, send network requests, or modify files.

Use `safe` to disable filesystem customization sources while troubleshooting, or `plugin-only` to load only explicit local plugin paths. Neither choice turns the bridge into a complete sandbox.

## Process and credential handling

The background Claude CLI inherits the normal environment needed by Claude Code so local authentication, provider configuration, hooks, plugins, MCP servers, and command tools behave natively. Environment variables visible to a normal Claude Code process are therefore also visible to the worker and to code it launches.

The bridge does not print or deliberately store Claude access tokens. It does not perform login, alter authentication, or attempt to bypass organization controls. Avoid placing unrelated secrets in global environment variables when running untrusted Claude customizations or bypass mode.

All subprocess creation uses argument arrays with `shell: false`. User prompts are not interpolated into a shell command by the bridge. Claude may independently invoke its Bash or PowerShell tools when its permission system allows that action.

## Data leaving the computer

At minimum, prompts and relevant context are sent to the configured Claude provider. Depending on enabled settings and tools, data can also be sent to MCP servers, web services, plugins, hooks, model providers, or commands started by Claude. Review those components' own security and privacy policies.

## Security regression checks

Changes should preserve these properties:

- deterministic commands remain intercepted before the Codex model;
- runtime approval resolves the current permission-prompt MCP request instead of restarting the task;
- bypass remains an explicit mode and is never silently selected by the MCP fallback;
- no organization or Claude policy error is circumvented;
- subprocesses use fixed executables, argument arrays, and `shell: false`;
- clipboard capture requires an explicit command;
- state and result paths remain under plugin data;
- tests and UTF-8 validation pass before release.
