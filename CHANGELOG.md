# Changelog

## 0.3.6

Release dated 2026-09-12. See [the test record](./TESTING.md) for measured results and remaining validation limits.

- Keep the permission MCP responsive during pending approvals. Cancellation clears the current request, queued approvals remain serialized, and terminal jobs cannot be revived by late decisions.
- Handle synchronous and asynchronous worker launch failures, remove unused task input, and honor cancellation before Claude starts. Support locking sessions with the maximum accepted ID length.
- Recover active jobs only after their registered worker is confirmed absent. Status, result retrieval, a new command and SessionEnd can finalize interrupted jobs, retain unconfirmed output, and clean private artifacts without reclaiming live or inaccessible processes.
- Record pending Hook ownership so SessionEnd can remove turn locks left by a terminated host. Reclaim dead locks through generation-specific recovery claims, preserving newly acquired locks, live owners, inaccessible owners and unidentifiable owners. Lock age alone no longer triggers reclamation.
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

Validation includes automated regression tests, independent plugin manifest validation, and real DeepSeek calls through Claude Code for reading, writing, images, both approval transports, denied writes, AskUserQuestion responses, auto and bypass modes, timeouts, plugin Skill execution, session resumption and session forking. Real Codex hosts on Windows, macOS and Ubuntu cover installation, command interception, interruption, recovery and cleanup. Windows also passed forced host-process-tree exit and recovery, with no host-model requests. The actual Windows desktop passed command interception, Stop, recovery, manual approval and the two-image queue-to-result flow. Clipboard checks cover native streams, Bitmap, file lists, all-pixel preservation, Paint copy, mixed image formats and quantity/size limits. Bounded fault injection uses actual Claude processes against a local scripted provider for disconnects, 429, 503, stalled responses, ten concurrent calls and thirty sequential calls; it is not a long-duration soak or a real cloud outage test.
