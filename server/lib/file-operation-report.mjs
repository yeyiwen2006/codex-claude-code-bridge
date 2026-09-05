import path from "node:path";

function normalize(value) {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(value);
  return windows ? path.win32.normalize(value).replaceAll("\\", "/").toLowerCase() : path.posix.normalize(value);
}

function basename(value) {
  return value.replaceAll("\\", "/").split("/").at(-1);
}

export function fileOperationReport(result) {
  const operations = (result.file_operations ?? []).filter(operation =>
    typeof operation.path === "string" && typeof operation.tool === "string");
  if (operations.length === 0) return { prefix: "", conflicts: [] };
  const successful = operations.filter(operation => operation.status === "succeeded");
  const conflicts = [];
  // Compare only explicit absolute paths in inline code with a unique successful
  // tool target of the same name. Do not rewrite arbitrary prose or guess paths.
  for (const match of (result.result ?? "").matchAll(/`([^`\r\n]+)`/g)) {
    const reported = match[1];
    if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(reported)) continue;
    const candidates = successful.filter(operation => /^[A-Za-z]:[\\/]|^\\\\/.test(operation.path)
      ? basename(operation.path).toLowerCase() === basename(reported).toLowerCase()
      : basename(operation.path) === basename(reported));
    const targets = new Map(candidates.map(operation => [normalize(operation.path), operation.path]));
    if (targets.size === 1 && !targets.has(normalize(reported))) {
      conflicts.push({ reported, tool_path: [...targets.values()][0] });
    }
  }
  const status = { succeeded: "工具返回成功", failed: "工具返回失败", unconfirmed: "未收到工具完成结果" };
  const prefix = [
    ...(result.ok === false ? ["Claude 任务未成功完成。"] : []),
    "文件操作记录（依据 Claude 工具调用与返回，非模型文字说明）：",
    ...operations.map(operation => `${operation.tool} · ${status[operation.status] ?? status.unconfirmed} · ${JSON.stringify(operation.path)}`),
    "此处仅列出已捕获的文件工具调用，不代表其他工具没有修改文件。",
    ...(conflicts.length ? ["路径核对：Claude 的文字说明与成功工具记录中的同名文件路径不一致。请以上述工具路径为准；原始说明保留在下方诊断元数据中。"] : []),
  ].join("\n");
  return { prefix, conflicts };
}
