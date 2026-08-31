# Claude Code Bridge

[中文说明](./README.md)

Claude Code Bridge is an unofficial, open-source local Codex plugin. It intercepts deterministic `/claude` commands before the Codex model starts, invokes an already-installed Claude Code CLI, and maintains a private multi-image Windows clipboard queue. A guarded MCP server and Codex Skill remain available as an optional model-directed fallback.

The project is not affiliated with or endorsed by OpenAI or Anthropic. It does not bundle Claude Code, an account, a subscription, or an API key.

## Execution paths

### Deterministic commands

```text
Codex composer
  → UserPromptSubmit hook
  → fixed command parser
  → local Claude Code CLI
  → the user's Claude model provider
```

The hook blocks the original `/claude` prompt, so the Codex model does not interpret the command or select an MCP tool. Isolated integration tests confirm that an intercepted command can complete with zero Codex input, output, and reasoning tokens.

The current public Codex hook API cannot create a normal assistant bubble. Command output therefore appears as the hook's blocking message. Long Claude results are previewed in the task and stored as complete UTF-8 text under the plugin's private data directory.

### MCP and Skill fallback

The plugin also exposes `claude_code_health`, `claude_code_authorize_directory`, `claude_code_plan`, and `claude_code_run`. These are for cases where the user explicitly wants the Codex model to coordinate Claude; they are not the implementation behind `/claude` commands.

## Direct multi-image handoff

`UserPromptSubmit` receives the prompt text but not the current uncommitted image attachments. The bridge therefore captures the same image data from the Windows clipboard after the user pastes into the Codex composer.

For one image:

```text
Paste the image into Codex
/claude image add
/claude image run -- Analyze the image and update the corresponding code
```

For several bitmap images:

```text
Paste image 1 → /claude image add
Paste image 2 → /claude image add
Paste image 3 → /claude image add
/claude image run -- Compare all queued images
```

When the clipboard contains a file-drop list with several image files, one `image add` captures all of them in clipboard order.

- The queue preserves insertion order and accepts up to 20 images.
- Each image is limited to 25 MiB and the queue to 100 MiB.
- File-drop copies and PNG clipboard streams preserve original bytes.
- A clipboard Bitmap is re-encoded as pixel-lossless PNG; original format and metadata may not survive.
- Duplicate detection uses the Windows clipboard sequence number, not file hashes.
- Use `/claude image add --force` to intentionally enqueue the same clipboard content again.
- Images are private to the current Codex task under `PLUGIN_DATA`.
- Images used by a run are consumed once the Claude invocation is attempted. Remaining images are removed on `SessionEnd` or by `/claude image clear`.

The bridge never reads the clipboard for ordinary chat or a plain `/claude run`. Standard Windows clipboard semantics usually expose only one raw bitmap at a time, so separate screenshots must be enqueued one by one.

## Command reference

```text
/claude help
/claude status

/claude access allow .
/claude access allow "C:\path\to\project"
/claude access show
/claude access revoke

/claude plan -- Analyze the authentication flow without editing
/claude run -- Fix the login bug and update its tests
/claude approve a1b2c3d4
/claude cancel a1b2c3d4

/claude image add
/claude image add --force
/claude image list
/claude image run -- Compare every queued screenshot
/claude image skill reviewer:visual-check -- Inspect the screenshots
/claude image clear
```

Configuration:

```text
/claude config show
/claude config set model sonnet
/claude config set model default
/claude config set effort high
/claude config set permission edit
/claude config set approval ask
/claude config set customizations plugin-only
/claude config set plugin-tools off
/claude config set timeout-seconds 1800
/claude config set max-budget-usd 5
/claude config set persist-session on
/claude config reset effort
/claude config reset all
```

Claude plugins, Skills, and sessions:

```text
/claude plugin list
/claude plugin add "C:\absolute\path\to\plugin"
/claude plugin add "C:\absolute\path\to\plugin.zip"
/claude plugin remove 1

/claude skill list
/claude skill run simplify -- Review the current changes
/claude skill run my-plugin:review -- Focus on permission boundaries

/claude session show
/claude session fork
/claude session clear
```

## Permissions and approvals

Each Codex task must explicitly authorize a canonical project root. The capability lasts four hours. Filesystem roots, the entire home directory, and Windows UNC share roots are rejected.

`permission` values:

| Value | Claude mode | Fixed tools |
|---|---|---|
| `plan` | `plan` | Read, Glob, Grep |
| `edit` | `acceptEdits` | Read, Glob, Grep, Edit, Write |
| `locked` | `dontAsk` | Only the pre-approved file tools |
| `auto` | `auto` | The same file tools, with Claude's classifier when supported |

The public build always denies Bash, PowerShell, WebFetch, and WebSearch. It does not support permission-bypass modes or arbitrary CLI arguments. Run tests, builds, and Git commands through Codex's own sandbox and approval system.

`approval` is a bridge-level batch policy:

- `ask`: stage a write-capable task and require `/claude approve <id>`.
- `auto`: start immediately after directory authorization.
- `deny`: reject all write-capable tasks.

Headless `claude -p` cannot surface Claude's interactive terminal permission dialog through a Codex hook, so `ask` deliberately uses a two-command approval flow.

## Claude customizations, plugins, and Skills

`customizations` controls which Claude configuration sources load:

- `safe`: Claude `--safe-mode`; no user or project customizations.
- `plugin-only`: no user/project settings; only explicit bridge `--plugin-dir` entries.
- `user`: user settings, Skills, plugins, and hooks.
- `project`: project and local sources.
- `all`: user, project, and local sources.

Only enable a source after trusting its hooks, MCP servers, plugins, and instructions. `plugin-tools=on` separately permits MCP tools contributed by loaded Claude plugins; it is off by default because those tools may access networks or external services.

`plugin add` records a local directory or ZIP for repeated `--plugin-dir` flags. It does not install, copy, update, or delete that plugin. Plugin Skills use Claude's `plugin-name:skill-name` namespace. `skill run` sends `/<skill-name>` directly to Claude, while ordinary runs can still let Claude select loaded Skills automatically.

Sessions are not persisted by default. When enabled, the bridge resumes only the exact UUID returned by Claude and binds it to the same authorized root. It never uses `--continue`. Claude Code itself may store JSONL transcripts containing prompts, source, and tool results in the user's Claude configuration directory.

## Security and data flow

- Fixed command grammar and argument arrays; prompts travel over stdin.
- `shell: false`; no user text is interpolated into a shell command.
- The resolved executable is canonicalized and must identify itself as Claude Code before a run.
- A small environment allowlist carries only authentication, proxy/certificate, and basic OS variables.
- API keys are never accepted as command or MCP arguments and are not logged.
- Deterministic commands are globally serialized. The MCP path caps concurrency and locks overlapping write scopes.
- Output limits, timeouts, cancellation, session/root binding, and private state files are enforced.
- Directory capabilities and file-tool restrictions are application controls, not an operating-system sandbox.

Local does not mean offline. Deterministic commands can send prompts, source snippets, and queued images through Claude Code to Anthropic or another configured provider. The MCP fallback additionally passes the user's request through Codex/OpenAI. Use only data you are authorized to share with the relevant services.

## Install

Requirements:

- Codex with local plugin and hook support.
- Node.js 18 or newer.
- A local Claude Code CLI; version `2.1.220` is currently verified.
- The user's own Claude login or Anthropic credentials.
- Windows 10/11 for direct composer-paste capture. Text commands and MCP remain portable, but macOS/Linux clipboard capture is not implemented yet.

After publishing this repository, replace `<repository-url>`:

```powershell
git clone <repository-url> "$env:USERPROFILE\plugins\claude-code-bridge"
node "$env:USERPROFILE\plugins\claude-code-bridge\scripts\register-personal-marketplace.mjs"
codex plugin add claude-code-bridge@personal --json
```

Then start a new Codex task, use `/hooks` to review and trust the plugin hooks, run `/claude status`, and authorize the specific project with `/claude access allow .`.

Update:

```powershell
git -C "$env:USERPROFILE\plugins\claude-code-bridge" pull --ff-only
codex plugin add claude-code-bridge@personal --json
```

Uninstall:

```powershell
codex plugin remove claude-code-bridge@personal
node "$env:USERPROFILE\plugins\claude-code-bridge\scripts\unregister-personal-marketplace.mjs" --yes
```

## Develop and test

```powershell
node .\scripts\check.mjs
node --test
```

Tests use a fake Claude executable and fake clipboard capture, consume no Claude allowance, do not modify a real project, and do not overwrite the user's clipboard. Public CI covers Node.js 18, 20, and 22 on Windows, macOS, and Ubuntu. Real Windows clipboard integration remains a local manual test because CI must not replace a user's system clipboard.

## Publishing scope

The whole directory can be published as a normal MIT-licensed GitHub project. Other users still install and authenticate Claude Code on their own machines and install this plugin locally.

A public GitHub repository is not the same as a universal OpenAI plugin-directory listing. This architecture depends on a local stdio MCP server, Codex hooks, the Windows clipboard, and a local Claude executable, so it cannot be submitted unchanged as a cloud-hosted HTTPS MCP service.

## License

MIT; see [LICENSE](./LICENSE). Claude Code, Codex, OpenAI services, and Anthropic services remain subject to their own licenses, terms, and privacy policies.
