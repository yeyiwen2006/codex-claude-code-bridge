# Contributing

Contributions are welcome when they preserve the plugin's local-first, explicit-authorization design.

Before opening a pull request:

1. Keep the MCP server dependency-free unless a dependency provides a concrete security or interoperability benefit that cannot reasonably be implemented with Node.js built-ins.
2. Do not add permission bypasses, arbitrary CLI flags, Bash/PowerShell exposure, silent clipboard reads, telemetry, credential logging, destructive Git cleanup, or automatic authentication changes.
3. Add or update tests for behavior changes, including command interception, multi-image ordering, state cleanup, and Windows-specific process/path behavior when applicable. Automated tests must use a fake clipboard provider and must not replace the developer's real clipboard.
4. Run `node ./scripts/check.mjs` and `node --test`.
5. Update both `README.md` and `README.en.md` when public behavior, security boundaries, installation, or supported platforms change.
6. Bump the plugin and package versions together for a release. Local Codex cachebuster suffixes are development metadata and should not be used as the public release version.

Bug reports should include versions and a minimal reproduction, but never include API keys, Claude session transcripts, proprietary source code, or unredacted home-directory paths.
