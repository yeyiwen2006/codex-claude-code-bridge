# Changelog

## 0.3.6

Release preparation updated on 2026-09-12. No tag or GitHub Release was created as part of this validation. Desktop verification after restarting the App passed; live system clipboard capture remains pending.

- Keep the permission MCP responsive during pending approvals. Cancellation clears the current request, queued approvals remain serialized, and terminal jobs cannot be revived by late decisions.
- Handle synchronous and asynchronous worker launch failures, remove unused task input, and honor cancellation before Claude starts. Support locking sessions with the maximum accepted ID length.
- Recover active jobs only after their registered worker is confirmed absent. Status, result retrieval, a new command and SessionEnd can finalize interrupted jobs, retain unconfirmed output, and clean private artifacts without reclaiming live or inaccessible processes.
- Validate both MCP transports before dispatch. Ignore request methods sent as notifications, reject duplicate active IDs and malformed parameters, and report unknown tools as protocol errors.
- Include image parent directories in MCP modification locks. Ignore relative PATH entries when resolving the Claude executable.
- Refuse image cleanup through directories redirected outside plugin data, including redirected image and session roots. Preserve supported data-root aliases.
- Make image cleanup retryable when the last image directory was removed before state was saved. Remove only selected stale records after validating the parent and confirming the directory entry is absent; continue rejecting dangling links.
- Isolate clipboard captures by batch so failed captures can be removed without disturbing existing images. Check file-drop quantity and size before copying and limit PNG stream writes.
- Load the Windows clipboard helper's system PowerShell utility module explicitly and read its test fixtures directly, avoiding module auto-discovery stalls in the restricted environment.
- Strip recognized host preambles from mixed conversation records. Reject inherited object property names in configuration reset commands.
- Forward explicit provider model names and aliases through the MCP environment and restricted runner, including `ANTHROPIC_MODEL`, the three `ANTHROPIC_DEFAULT_*_MODEL` variables, and `CLAUDE_CODE_SUBAGENT_MODEL`.
- Reject invalid personal marketplace identifiers without changing the file. Compare canonical installation directories so home-directory aliases work on macOS and Windows. Detect UTF-8 BOMs correctly and preserve Chinese text in the encoding checks.
- Read both MCP server versions from the package version. Extend CI to Node.js 24 while retaining the existing Node.js 18, 20 and 22 matrix.

Validation includes 136 local automated tests, independent plugin manifest validation, and real DeepSeek calls through Claude Code for reading, writing, images, both approval transports, explicit plugin Skill execution, session resumption and session forking. Real Codex host tests also cover interruption, dead-worker recovery, a successful subsequent write and exit cleanup. After restarting the App, its actual desktop interface passed command interception, Stop, recovery, a new task and manual write approval. See [the test record](./TESTING.md) for methods and remaining platform limits.
