function hasResultText(result) {
  return typeof result.result === "string" && result.result.trim().length > 0;
}

export function formatClaudeJobResult(result, request) {
  const emptyResult = !hasResultText(result);
  const metadata = {
    ok: result.ok,
    subtype: result.subtype ?? null,
    session_id: result.session_id ?? null,
    exit_code: result.exit_code ?? null,
    exit_signal: result.exit_signal ?? null,
    elapsed_ms: result.elapsed_ms,
    claude_duration_ms: result.claude_duration_ms ?? null,
    api_duration_ms: result.api_duration_ms ?? null,
    num_turns: result.num_turns ?? null,
    total_cost_usd: result.total_cost_usd ?? null,
    stop_reason: result.stop_reason ?? null,
    terminal_reason: result.terminal_reason ?? null,
    api_error_status: result.api_error_status ?? null,
    protocol_warning: result.protocol_warning ?? null,
    errors: result.errors ?? [],
    permission_denials: result.permission_denials ?? [],
    empty_result: emptyResult,
    permission_mode: request.input.permissionMode,
    customizations: request.input.customizationSources,
    codex_conversation_messages: request.conversation?.messageCount ?? 0,
    codex_conversation_truncated: request.conversation?.truncated ?? false,
  };
  const primary = emptyResult
    ? result.ok
      ? [
          "Claude Code 已成功结束，但结果正文为空。Bridge 没有丢弃非空 result。",
          "这通常来自 Claude Code 自身的 Hook、插件、设置或输出协议；可先用 customizations=plugin-only 复测，再查看下方诊断元数据。",
        ].join("\n")
      : "Claude Code 未成功完成，也没有返回结果正文；请查看下方诊断元数据。"
    : result.result;
  return `${primary}\n\n[Codex Claude Code Bridge 元数据]\n${JSON.stringify(metadata, null, 2)}`;
}
