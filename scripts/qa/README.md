# 手动补测

这些脚本使用专用临时目录，不会随 `npm test` 自动运行。测试结果和边界见仓库根目录的 [TESTING.md](../../TESTING.md)。运行真实模型案例会调用已配置的服务并产生其对应费用。

## 权限与真实宿主

安装 Claude Code 和 Codex，提前通过进程环境配置模型服务认证。脚本不打开个人凭据文件，也不输出认证内容。宿主的模型地址指向本机拒绝端点，用于确认确定性命令没有请求宿主模型。

```powershell
node scripts/qa/live-permissions.mjs --setup-only
node scripts/qa/live-permissions.mjs --cases deny,question-safe,question-mcp,auto,bypass,timeout
```

可通过 `--codex` 指定 Codex 可执行文件。Windows 的 PATH 若只包含 `codex.cmd` 或 `codex.ps1`，需要显式指定原生 `codex.exe`，脚本不通过 shell 执行这些包装脚本。前一条只验证 Hook 与退出清理，后一条使用真实 Claude 测试权限、问题回答和超时。

```powershell
node scripts/qa/cross-platform-host.mjs --setup-only
node scripts/qa/cross-platform-host.mjs
```

跨平台脚本覆盖独立安装、注册、实际调用、中断、恢复和卸载，可用 `BRIDGE_QA_CODEX_BIN` 指定宿主；Claude 使用生产入口的命令解析规则。此脚本要求固定版本 Codex 0.153.4 和 Claude Code 2.1.261，`--setup-only` 也会检查版本。GitHub 的 `Release host validation` 工作流默认手动运行 Ubuntu 与 macOS，也可用 `platform` 选项只验证其中一端，认证由仓库的 `BRIDGE_RELEASE_DEEPSEEK_API_KEY` Secret 提供。发布验证的临时 Secret 在测试结束后删除，之后再次运行需要先配置。工作流只上传经过筛选的 JSON 结论，不上传个人配置或模型原始输出。

## 可控故障

```powershell
node scripts/qa/fault-recovery.mjs
node scripts/qa/fault-recovery.mjs --host-only --codex=C:/path/to/codex.exe
```

故障脚本使用真实 Claude 可执行文件和本机脚本化模型端点，不需要真实 API Key。第一条验证断连、限流、服务错误、停滞及恢复，不代表真实提供商遭遇过故障。并发与顺序循环为有界检查，没有持续数小时运行。第二条需要替换为实际 Codex 路径，专门验证所创建宿主进程树强制退出后的恢复，已在 Windows 实测。

## Windows 剪贴板

此脚本需要 Windows、Python 和 Pillow。它会覆盖系统剪贴板，结束时留下两张生成的 PNG 文件引用，不恢复之前的剪贴板内容；运行前应确保原有剪贴板内容不再需要。

```powershell
node scripts/qa/windows-clipboard.mjs --overwrite-clipboard
```

可用 `BRIDGE_QA_PYTHON` 指定 Python。八项检查包括 Bitmap 与透明 PNG 全像素比较、四种图片格式混合入队、数量边界、单图容量边界和总量超限。容量图片通过附加尾部字节生成，只验证文件字节上限。脚本在专用临时目录保留小型证据文件，清理大型夹具和队列副本，将摘要写到被 Git 忽略的 `artifacts/windows-clipboard.json`。
