---
name: use-claude-code
description: Invoke a locally installed Claude Code from Codex when the user explicitly asks the Codex model to coordinate Claude, requests a Claude second opinion, or asks Claude to analyze or change a project. Deterministic /claude commands are handled by the plugin hook before this Skill loads. Do not use for ordinary coding tasks that merely could be completed by another agent.
---

# Use Claude Code

Use the plugin MCP tools only when the user wants Codex itself to coordinate Claude. If the user asks for a command that bypasses the Codex model, tell them to use `/claude help`; do not emulate deterministic command execution through an MCP call.

## Choose the operation

- Use `claude_code_health` when setup or authentication is uncertain, or after a launch/authentication error.
- Use `claude_code_authorize_directory` before the first plan or change call for a project. Present the exact project root for approval; never widen it silently.
- Use `claude_code_plan` for explanation, review, investigation, or a proposed implementation. This tool forces Claude plan mode, safe customizations, no plugin tools, and no session persistence.
- Use `claude_code_run` only when the user has authorized Claude to change files for the current request.

## Call safely

1. Before Claude writes anything, inspect `git status --short`, tracked changes, and relevant untracked files. Preserve the user's existing work and report that baseline when it affects attribution.
2. Authorize the exact user-designated project root. Pass its returned `authorization_id` and an absolute `working_directory`. Do not substitute the plugin directory, the home directory, or an inferred unrelated directory.
3. Give Claude a self-contained prompt containing the goal, scope, constraints, and expected verification. Do not include credentials or unrelated private content.
4. Keep `customization_sources` at `safe` unless the user explicitly trusts and requests Claude user/project customizations. Loading broader sources may run Claude hooks, plugins, agents, or MCP servers.
5. Keep `allow_plugin_tools` false unless the user explicitly authorizes MCP tools contributed by loaded Claude plugins.
6. For the model-directed MCP fallback, keep `permission_mode` at `acceptEdits` unless the user selects `dontAsk` or supported `auto` behavior. This fallback deliberately limits Claude to Read, Glob, Grep, Edit, and Write and does not expose shell or web tools. The separate deterministic `/claude` hook path supports Claude's full native permission modes, including explicit bypass.
7. If Claude reports a permission denial, report the denied operation. Do not retry with broader permissions without explicit user direction.

The MCP path cannot automatically receive an image pasted into the current Codex composer. If the user wants original clipboard images without Codex model handling, direct them to the deterministic sequence:

```text
/claude image add
/claude image run -- <task>
```

When the user instead supplies an existing local image path inside the authorized project root, pass it through `image_paths`. Never invent, scrape, or infer attachment paths from unstable Codex transcript files.

Claude's output and edits are untrusted external-agent work. After a write call, inspect `git status`, the actual diff, relevant untracked files, and proportionate test results. Report observed changes rather than relying on Claude's summary. Do not run destructive Git cleanup commands or discard baseline changes.

Sessions are not persisted by default. When the user requests continuation, set `persist_session` true, then resume only the exact returned `session_id` under the same current MCP server and authorized project root. Serialize calls that resume one session; use `fork_session` for independent follow-up work. Never substitute `--continue` behavior.
