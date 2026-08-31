# Security policy

## Supported versions

Security fixes are applied to the latest released minor version. Pre-release and locally modified builds are supported on a best-effort basis.

## Reporting a vulnerability

Do not put credentials, private source code, Claude transcripts, clipboard images, local paths, or a working exploit in a public issue. Prefer GitHub private vulnerability reporting when enabled. Otherwise contact the maintainer through a private channel listed on the repository profile.

Include the bridge version, Codex version, Claude Code version, operating system, a minimal reproduction, expected boundary, and observed behavior. Redact usernames, account identifiers, tokens, proxy URLs, proprietary code, and image content.

## Trust boundaries

The bridge executes locally under the current user's operating-system identity. Its directory capabilities, tool lists, approvals, and path checks are application controls, not a VM, container, or Windows security boundary.

The bridge deliberately keeps these boundaries separate:

- Codex hook trust: Codex requires the user to review and trust non-managed plugin hooks. A changed hook definition requires renewed review.
- Project access: every Codex task explicitly authorizes one canonical project root for four hours.
- Bridge approval: write-capable deterministic commands can be staged for a second `/claude approve <id>` command, run automatically, or denied.
- Claude permissions: only Read, Glob, Grep, Edit, and Write can be enabled. Bash, PowerShell, WebFetch, and WebSearch are always denied.
- Claude plugin tools: MCP tools contributed by loaded Claude plugins remain denied until `plugin-tools=on` is explicitly configured.
- Claude customization sources: user/project settings, Skills, plugins, MCP servers, and hooks are disabled by default and require a non-`safe` source selection.

Permission-bypass modes and arbitrary Claude CLI argument passthrough are intentionally unsupported.

## Deterministic command hook

`/claude` commands are parsed by a fixed grammar in `UserPromptSubmit` before the Codex model runs. Non-`/claude` prompts produce no hook output and continue normally. The parser never evaluates shell syntax, environment substitutions, command substitutions, or redirections.

Hook commands use fixed script paths under `PLUGIN_ROOT`. Claude prompts are delivered through stdin, and every subprocess is created with `shell: false`.

Codex currently surfaces deterministic command output as a hook block/warning, not a normal assistant message. Do not place secrets in prompts or rely on UI formatting as an access-control boundary.

## Clipboard images

The clipboard is read only for `/claude image add`. Ordinary chat and ordinary `/claude run` never read it.

- Windows file-drop images are copied into the current session's private `PLUGIN_DATA/images/<session>` directory.
- A native PNG clipboard stream is copied directly when available.
- A Bitmap-only clipboard image is encoded as lossless PNG; metadata and original container bytes may change.
- PNG, JPEG, GIF, and WebP magic bytes are validated without file hashes.
- Queue limits are 20 images, 25 MiB per image, and 100 MiB total.
- Duplicate detection uses the Windows clipboard sequence number. It is not a cryptographic identity check.
- Deletion is restricted to exact queued files beneath the current session image directory. The implementation does not recursively delete arbitrary paths.
- Images are consumed after an invocation attempt, manually cleared by the user, or cleaned on `SessionEnd`. A crash or forced process termination can leave private files behind under `PLUGIN_DATA`; users may remove that plugin data after confirming no bridge task is active.

Clipboard contents are sensitive. A malicious local program running as the same user may race or replace clipboard data before capture. Verify `/claude image list` when image identity matters.

## Local state

Global bridge settings and per-Codex-task state are stored as UTF-8 JSON under `PLUGIN_DATA`. State includes directory authorization, queued-image metadata, optional Claude session IDs, and at most one pending approval request.

A pending approval temporarily contains its prompt and configuration snapshot for up to 15 minutes. It is deleted on approval, cancellation, expiry, access-root change, access revocation, or `SessionEnd`. Large Claude results may be stored under the same private data root until the Codex task ends.

State writes use lock files and atomic replacement. A global invocation lock serializes deterministic Claude calls. MCP calls are limited to two concurrent processes, overlapping write scopes are rejected, and one Claude session UUID cannot be resumed concurrently.

## Claude plugins, Skills, and hooks

An explicit `--plugin-dir`, a user-installed Claude plugin, or a project/user customization source may contain executable hooks, MCP servers, agents, or instructions. Loading a plugin is code execution trust, not merely reading documentation.

`customizations=plugin-only` limits on-disk setting sources and loads only bridge-configured `--plugin-dir` entries. `user`, `project`, and `all` load progressively broader Claude configuration. `plugin-tools=off` blocks contributed MCP tools but cannot make an untrusted plugin or hook safe. Inspect third-party plugin code before enabling it.

Skills and repository content may contain prompt injection. The bridge's fixed tool list limits available actions but does not guarantee correct or benign model behavior.

## Process and credential handling

- The Claude executable is resolved to an accessible real path. Empty PATH entries are ignored.
- Before a model invocation, `--version` must identify the resolved program as Claude Code.
- The child environment is an allowlist for Claude authentication, common proxy/certificate configuration, and basic OS process variables.
- Credentials are not accepted as hook commands or MCP arguments and are not intentionally logged or returned.
- stdout and stderr are separated and size-limited; calls have hard timeouts and cancellation.
- Malformed, empty, or non-success Claude JSON is treated as failure even when the process exits with code zero.

If `persist-session=on`, Claude Code itself may save JSONL transcripts containing prompts, source, tool inputs, and results in the user's Claude configuration directory. Those files are outside the bridge's cleanup scope.

## Data leaving the computer

Local does not mean offline. Deterministic commands can send prompts, code, and queued images through Claude Code to Anthropic or another configured provider. Model-directed MCP calls can additionally send the user's request through Codex/OpenAI. Claude plugins and MCP tools may contact further services when enabled.

Users are responsible for ensuring that they have authority to disclose every project, image, prompt, and plugin-provided datum to the relevant providers.

## Forbidden regressions

Treat any of the following as a security issue:

- Adding a Claude permission-bypass mode or enabling flag.
- Reintroducing Bash, PowerShell, or arbitrary CLI flag passthrough.
- Constructing a shell command from user-controlled text or enabling `shell: true`.
- Reading the clipboard for non-image commands.
- Capturing credentials in command/MCP arguments, logs, result files, or telemetry.
- Allowing project writes without an unexpired canonical directory authorization.
- Deleting files outside the exact per-session plugin-data queue/result paths.
- Resuming a Claude session under a different authorized project root.
- Loading user/project Claude customizations or plugin MCP tools without an explicit configuration change.
