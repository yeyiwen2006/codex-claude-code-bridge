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
    original_result_empty: result.original_result_empty ?? emptyResult,
    result_recovered_from_stream: result.result_recovered_from_stream ?? false,
    stream_assistant_messages: result.stream_assistant_messages ?? null,
    stream_event_counts: result.stream_event_counts ?? null,
    loaded_plugins: result.loaded_plugins ?? [],
    plugin_errors: result.plugin_errors ?? [],
    hook_failures: result.hook_failures ?? [],
    recovery_includes_history: result.recovery_includes_history ?? false,
    native_session_files: result.native_session_files ?? null,
    permission_mode: request.input.permissionMode,
    customizations: request.input.customizationSources,
    codex_conversation_messages: request.conversation?.messageCount ?? 0,
    codex_conversation_truncated: request.conversation?.truncated ?? false,
    claude_history_entries: request.conversation?.bridgeHistoryEntries ?? 0,
  };
  const primary = emptyResult
    ? result.ok
      ? [
          "Claude Code 已成功结束，但结果正文为空：最终 envelope 与主会话 assistant 流都没有可恢复文本。Bridge 不会自动重试，因此不会为同一空结果再次产生模型费用。",
          "请先查看下方的回合数、费用、已加载插件与 stream 事件计数。若需做一次隔离复测，可先设置 customizations=plugin-only 或 safe，并设置较小的 max-budget-usd。",
        ].join("\n")
      : "Claude Code 未成功完成，也没有返回结果正文；请查看下方诊断元数据。"
    : result.result;
  const hookNote = result.hook_failures?.length > 0
    ? "\n\n诊断：Claude 自定义 Hook 曾返回错误。若出现重复回复或反复寻找会话记录，请检查下方 hook_failures；桥接器未重新发送任务。"
    : "";
  return `${primary}${hookNote}\n\n[Codex Claude Code Bridge 元数据]\n${JSON.stringify(metadata, null, 2)}`;
}
