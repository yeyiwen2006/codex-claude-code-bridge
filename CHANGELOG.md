# Changelog

## 0.3.6

Release preparation completed on 2026-09-12. No tag or GitHub Release was created as part of this validation.

- Keep the permission MCP responsive during pending approvals. Cancellation clears the current request, queued approvals remain serialized, and terminal jobs cannot be revived by late decisions.
- Handle synchronous and asynchronous worker launch failures, remove unused task input, and honor cancellation before Claude starts. Support locking sessions with the maximum accepted ID length.
- Validate both MCP transports before dispatch. Ignore request methods sent as notifications, reject duplicate active IDs and malformed parameters, and report unknown tools as protocol errors.
- Include image parent directories in MCP modification locks. Ignore relative PATH entries when resolving the Claude executable.
- Refuse image cleanup through directories redirected outside plugin data, including redirected image and session roots. Preserve supported data-root aliases.
- Isolate clipboard captures by batch so failed captures can be removed without disturbing existing images. Check file-drop quantity and size before copying and limit PNG stream writes.
- Strip recognized host preambles from mixed conversation records. Reject inherited object property names in configuration reset commands.
- Forward explicit provider model names and aliases through the MCP environment and restricted runner, including `ANTHROPIC_MODEL`, the three `ANTHROPIC_DEFAULT_*_MODEL` variables, and `CLAUDE_CODE_SUBAGENT_MODEL`.
- Reject invalid personal marketplace identifiers without changing the file. Compare canonical installation directories so home-directory aliases work on macOS and Windows. Detect UTF-8 BOMs correctly and preserve Chinese text in the encoding checks.
- Read both MCP server versions from the package version. Extend CI to Node.js 24 while retaining the existing Node.js 18, 20 and 22 matrix.

Validation includes 126 local automated tests, independent plugin manifest validation, and real DeepSeek calls through Claude Code for reading, writing, both approval transports, explicit plugin Skill execution, session resumption and session forking. See [the test record](./TESTING.md) for methods and remaining UI and platform limits.
