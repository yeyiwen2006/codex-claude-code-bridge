# Codex Claude Code Bridge

[English](./README.en.md)

Codex Claude Code Bridge 是一个面向 Codex 或 ChatGPT Work 的非官方、开源本地插件。只需要在 Codex App 里交互，就可以同时操控 Codex 和 Claude Code 两大 Agent 框架，在同一工作流中按需调用 Claude Code。为 Claude Code 配置兼容的模型服务后，还可以通过它调用 [DeepSeek](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)、[GLM](https://docs.z.ai/devpack/tool/claude) 等其他模型。

更重要的是，插件默认会将当前 Codex 或 ChatGPT Work 任务中可见的对话上下文直接传递给 Claude Code，让你复用已经讨论的需求、方案和任务进度，实现无缝切换。在插件已安装、Hook 已信任、项目目录已授权的任务中，当 Codex 或 ChatGPT Work 额度不足、需要转用 Claude Code 时，只需输入 `claude run -- ...`，就可以让 Claude Code 复用原有上下文，在现有工作流中继续任务，无需重新整理背景或复制粘贴整段对话。

你可以在 Codex App 的 Codex 或 ChatGPT Work 本地任务中，以及 Codex CLI 的聊天框中直接输入确定性 `claude` 命令。Hook 会在宿主模型启动前拦截命令，再调用本机 Claude Code CLI，因此接续任务不需要先由 Codex 或 ChatGPT Work 的模型理解或转述请求。运行时审批使用 Claude 官方的 `--permission-prompt-tool` MCP 接口。

它支持当前 Codex 或 ChatGPT Work 对话继承、多张剪贴板原图、Claude Code 后端模型与推理力度、六种原生权限模式、运行时逐工具审批、Claude Skills、插件、Hooks 与 MCP，以及 Claude 会话恢复。

本项目与 OpenAI、Anthropic 均无从属或背书关系，也不附带 Claude Code、账号、订阅或 API 密钥。

> `claude ...` 是 App 与 CLI 通用的插件 Hook 命令，不是 Codex 或 ChatGPT Work 的内置命令。Codex App 还兼容 `/claude ...`；Codex CLI 会在 Hook 运行前拒绝未知的内置斜杠命令，因此在 CLI 中必须省略 `/`。安装并信任 Hook 后，这两种受支持的入口都不会先交给 Codex 或 ChatGPT Work 的模型解释。

## 支持范围

完整插件面向具备本地插件、Hooks 和会话记录能力的 Codex 或 ChatGPT Work 桌面任务，并支持 Codex CLI。它依赖 `.codex-plugin` 清单、Codex 的 `UserPromptSubmit`/`Interrupt`/`SessionEnd` Hook、任务级 `PLUGIN_DATA`、`transcript_path` 和 Codex Skill，因此不能作为其他 Agent 的等价插件直接安装。本文中的 ChatGPT Work 指具备这些本地能力的桌面环境，网页版和纯云端任务不在完整插件支持范围内。宿主的插件机制可参考 [OpenAI 插件文档](https://learn.chatgpt.com/docs/plugins)。

其他支持本地 stdio MCP 的 Agent 可以自行配置 `.mcp.json` 中的 MCP 服务器，并复用 `claude_code_health`、`claude_code_authorize_directory`、`claude_code_plan` 和 `claude_code_run` 四个保守工具；这种方式不包含确定性 `claude` 命令、Codex 或 ChatGPT Work 对话继承、任务清理、剪贴板图片队列或原生运行时审批，属于有限的 MCP 复用，不是完整产品支持。

## 最简单的用法

第一次使用：

```text
claude access allow .
claude status
claude run -- 请概述当前项目
```

默认 `manual` 模式会立即启动 Claude。只读分析通常不会先弹审批；Claude 真正请求一个尚未获准的工具时，任务才暂停并显示工具名、参数和权限请求 ID。例如：

```text
claude allow a1b2c3d4 once
```

批准后是同一个 Claude 进程、同一个工具调用、同一项任务从暂停处继续，不会重新发送任务。

`plan`、`run`、`image run` 与 `skill run` 正常会一直等待到 Claude Code 得到最终结果，再由当前这次 Hook 一次返回；不再在固定 30 秒后要求手动轮询。detached worker 仍然保留，用于真实审批、Codex 或 ChatGPT Work 任务中断、Hook 超时和 App 意外退出后的安全收尾。

## Codex App（Codex 或 ChatGPT Work）与 Codex CLI

### 在 Codex App 的 Codex 或 ChatGPT Work 本地任务中

1. 安装并启用插件。
2. 打开“设置”→“钩子”，审查插件的 `UserPromptSubmit`、`Interrupt` 和 `SessionEnd` Hook。确认来源为 `codex-claude-code-bridge@personal`，命令只启动插件内的 `scripts/command-hook.mjs`，然后信任。
3. 完全退出并重新打开 Codex App，在目标项目中新建一个 Codex 或 ChatGPT Work 本地任务。
4. 直接发送 `/claude status` 或 `claude status`。如果返回 Claude Code 状态，说明 Hook 已生效。

Codex App 输入框可以选择 Codex Claude Code Bridge 插件，选择后会在输入框上方显示插件名。那主要用于自然语言触发 MCP/Skill 兼容路径。确定性 `claude ...` 命令和 App 的 `/claude ...` 别名都不要求每条消息带插件名，也不需要先选择插件。

首次安装以及更新后 Hook 被标记为 `new or changed` 时，都可以在 Codex App 的“设置”→“钩子”中重新审查并信任。也可以在 Codex CLI 中使用 `/hooks` 完成同样的操作。

### 在 Codex CLI 中

1. 运行 `codex`。
2. 用 `/plugins` 确认 `codex-claude-code-bridge` 已安装并启用。
3. 用 `/hooks` 审查并信任插件的 `UserPromptSubmit`、`Interrupt` 和 `SessionEnd` Hook。
4. 新建会话或重新启动 CLI。
5. 发送 `claude status`，然后执行 `claude access allow .`。不要添加 `/`，否则 CLI 会把它当作未知内置斜杠命令，并在 Hook 收到消息前拒绝。

之后 App 和 CLI 的子命令、参数与行为完全相同；差别只在于 CLI 使用 `claude ...`，App 两种写法都支持。

## 权限模式

桥接器透传 Claude Code 的原生权限判断顺序，包括 Claude Hooks、`deny` 规则、`ask` 规则、权限模式、`allow` 规则和运行时审批回调。

| 插件名称 | Claude 原生模式 | 行为 |
| --- | --- | --- |
| `manual` | `manual` | 不预先批准未匹配工具；遇到真实权限请求时暂停 |
| `accept-edits` | `acceptEdits` | 自动批准 Claude 原生定义的文件编辑和文件系统操作，其他未获准工具仍会询问 |
| `plan` | `plan` | 以 Claude 原生计划模式运行；写操作不会自动获准 |
| `auto` | `auto` | 由 Claude 的权限分类器批准或拒绝，取决于账号与组织策略是否支持 |
| `dont-ask` | `dontAsk` | 未被规则预先允许的请求直接拒绝，不进入人工审批 |
| `bypass` | `bypassPermissions` | 绕过普通权限提示，完整开放 Claude 可见工具；风险最高 |

设置全局默认：

```text
claude config set permission manual
```

只覆盖当前 Codex 或 ChatGPT Work 会话后续任务：

```text
claude mode accept-edits
claude mode default
```

只覆盖一次调用：

```text
claude run --permission plan -- 先分析实现方案
claude run --permission bypass -- 完成构建、测试和提交前检查
```

`image run`、`skill run` 和 `image skill` 也支持相同的 `--permission <模式>`。

### bypass 的准确含义

`bypass` 会向 Claude CLI 传递 `--permission-mode bypassPermissions` 与必须的显式危险模式开关。桥接器不会再附加以下限制：

- 不限制为 Read/Edit 等固定工具集合；
- 不屏蔽 Bash、PowerShell、WebFetch、WebSearch；
- 不屏蔽 Claude 插件或 MCP 工具；
- 不把已授权项目目录当作操作系统沙箱；
- 不改变当前 Windows 用户的文件、网络和进程权限。

`claude access allow .` 在此模式下只是确认启动目录并将 Claude 会话绑定到该根目录，不是隔离边界。Claude 自身仍可能执行 Hooks、组织策略、`deny`/`ask` 规则、关键路径保护和跨会话安全保护。如果企业策略关闭 bypass，插件会显示 Claude 返回的错误，不会绕过策略。

## 运行时审批

`manual`、`accept-edits`、`plan` 等模式中，只有 Claude 原生权限流程没有提前解决的工具请求才会进入插件审批。后台 worker 保持官方 SDK 查询和 Claude 进程存活；审批回调一直等待，直到用户决定或取消任务。

```text
claude allow a1b2c3d4 once
claude allow a1b2c3d4 session
claude allow a1b2c3d4 project
claude allow a1b2c3d4 user
claude deny a1b2c3d4 -- 不要删除文件，请改为归档
```

`session`、`project`、`user` 会在 Claude 提供相应原生权限建议时，将建议原样交回权限提示工具。`project` 优先使用项目本地或项目设置目标。

如果 Claude 调用 `AskUserQuestion`，插件会显示问题 JSON。按问题原文填写答案：

```text
claude answer a1b2c3d4 -- {"使用哪种数据库？":"SQLite"}
```

正常任务会在 `timeout-seconds` 允许的范围内同步等待最终结果。只有下面几种情况会在终态前返回：Claude 正在等待真实工具审批或 `AskUserQuestion`；Codex 或 ChatGPT Work 的当前回合被中断；或者 worker 在 Claude 超时之后仍未能在 Hook 的收尾保护时间内写入终态。审批时提交 `allow`、`deny` 或 `answer` 后，插件继续等待同一个 Claude 进程的最终结果或下一次审批。

Codex 或 ChatGPT Work 本地任务的停止按钮会触发 `Interrupt` Hook 并取消 worker。以下命令主要用于审批之间、Hook/App 异常退出后的恢复与显式取消，不再是普通调用的必经步骤：

```text
claude status
claude result
claude cancel 1a2b3c4d
```

同一个 Codex 或 ChatGPT Work 任务的 `turn_id` 即使被重复加载的 Hook 实例并发收到，也只执行一次；其余实例静默退出，避免一条提交产生两个相同结果。

## 当前 Codex 或 ChatGPT Work 对话继承

`run`、`plan`、`image run`、`skill run` 默认读取 Hook 提供的 `transcript_path`，提取当前 Codex 或 ChatGPT Work 任务中可见的用户消息和助手回复，并把本次任务放在最前面交给 Claude Code。你可以直接要求 Claude Code 根据上文继续尚未完成的工作，例如：

```text
claude run -- 请结合上文的需求、方案和任务进度，检查当前项目状态并继续尚未完成的任务。
```

这条确定性命令无需先调用 Codex 或 ChatGPT Work 的模型，适合在额度不足时接续任务。继承范围是会话记录中的可见对话文本；长对话会按长度限制保留开头和最近内容。工具原始日志、隐藏推理和密钥不会被主动提取。

```text
claude config set conversation-context off
claude config set conversation-context on
```

对话中可能包含秘密、专有材料或提示词注入。关闭继承只影响后续调用。

## 多张原图

Codex Hook 目前不提供“本次尚未提交附件”的像素内容，所以插件从 Windows 剪贴板直接捕获刚粘贴的原始位图或图片文件，不需要用户手动另存。

Codex App 会在带附件的提交中加入附件清单和 `My request` 包装。桥接器只识别该包装内明确的用户请求；附件文件名、文档内容或其他区域即使出现 `claude` 或 `/claude` 文字也不会触发命令。

单张图片：

1. 在任意应用复制图片或在 Codex 或 ChatGPT Work 输入框粘贴图片。
2. 发送 `claude image add`。
3. 发送 `claude image run -- 描述或比较这张图片`。

多张图片时，每复制或粘贴一张，就发送一次 `claude image add`；一次复制多个图片文件也可以一次全部加入。随后：

```text
claude image list
claude image run [--permission <模式>] -- 对比全部图片
claude image skill <Skill 名称> [--permission <模式>] -- [参数]
claude image clear
```

图片按队列顺序交付。任务完成或失败后，已交付的图片会从队列移除；运行中的任务仍引用图片时不会允许清空。

## Claude 配置、插件与 Skills

```text
claude config show
claude config set model opus
claude config set effort high
claude config set permission manual
claude config set customizations all
claude config set timeout-seconds 1800
claude config set max-budget-usd off
claude config set persist-session on
claude config set conversation-context on
claude config reset [键|all]
```

`customizations`：

| 值 | 加载内容 |
| --- | --- |
| `safe` | 不加载用户、项目和本地设置；用于排查损坏配置 |
| `plugin-only` | 只加载用 `claude plugin add` 显式加入的本地插件 |
| `user` | 用户级设置、Skills、插件、Hooks 与 MCP |
| `project` | 项目与本地设置、CLAUDE.md、Skills、插件、Hooks 与 MCP |
| `all` | 不向 Claude CLI 指定 settingSources，使用原生默认加载行为 |

新安装默认是 `all`，因此 Claude Code 中正常可用的配置、Skills、Hooks、插件和 MCP 通常会照常加载。

```text
claude plugin list
claude plugin add "C:\绝对路径\my-plugin"
claude plugin remove <序号|绝对路径>
claude skill list
claude skill run my-plugin:review -- 检查权限边界
```

加载的 Claude Hooks、插件和 MCP 都能执行本地代码或外部操作，权限效果仍按 Claude 原生流程决定。

## Claude 会话

```text
claude config set persist-session on
claude session show
claude session clear
claude session fork
```

成功调用后保存 Claude session ID；同一授权根目录中的下一次调用可以恢复。`session fork` 让下一次恢复产生新的 Claude 会话分支。

## 完整命令入口

发送 `claude help` 获取当前安装版本的准确命令列表。常用入口：

```text
claude help
claude status
claude access allow [绝对路径|.]
claude access show
claude access revoke
claude run [--permission <模式>] -- <提示词>
claude plan -- <提示词>
claude result
```

## 两种调用路径

确定性 Hook 路径由 `claude` 命令直接触发，不需要 Codex 或 ChatGPT Work 的模型理解命令；Codex App 还支持 `/claude` 别名。当前使用的 Codex Hook 接口不能创建普通助手气泡，因此返回值显示为 Hook 阻止信息。

插件还提供受保护的 MCP 与 Codex Skill 兼容路径，供用户明确要求“让 Codex 或 ChatGPT Work 协调 Claude Code”时由宿主模型调用。这条路径需要宿主模型参与；额度不足时应使用上面的确定性 `claude` 命令。MCP 回退仍保留单独的目录能力与保守工具面，不等同于确定性命令中的原生权限透传，也不会自动启用 bypass。

## 已知边界与排查

- Claude Code 偶尔会以成功状态结束但返回空的最终 `result`，尤其是加载用户或项目自定义项时。确定性命令使用 `stream-json`，会先恢复主会话最后一条非空 assistant 文本；若最终 envelope 和 assistant 流都为空，插件会显示回合数、费用、已加载插件和 stream 事件计数，并且不会自动重试。需要做一次低成本隔离复测时，先执行 `claude config set customizations plugin-only` 或 `safe`，再设置较小的 `max-budget-usd`，然后检查 Claude Hooks、插件和设置。
- 继承的 Codex 或 ChatGPT Work 对话会作为用户提供的上下文交给 Claude。Claude 自身可能把其中内容判定为提示词注入并拒绝执行；需要时可执行 `claude config set conversation-context off`，再用独立、明确的提示词重试。
- Codex CLI 的非交互 `codex exec` 目前可能只显示 Hook 已阻止请求，而不显示 Hook 返回的完整原因。Hook 信任可在 Codex App 的“设置”→“钩子”或交互式 Codex CLI 的 `/hooks` 中完成；排障时不要使用非交互 `codex exec`。
- `max-budget-usd` 由 Claude Code 原生执行，可能在一个已经开始的 API 回合结束后才停止，因此总费用可能小幅超过所设上限；它不是预付费硬闸门。
- `claude status` 会显示当前进程是否设置了自定义 `ANTHROPIC_BASE_URL`，但不会泄露 URL。若认证显示正常而调用长期停在 `running`，可运行 `claude doctor` 检查端点与登录状态；桥接器会尊重 Claude 环境，不会擅自改写自定义端点。

## 安装

要求：

- 支持本地插件、Hooks 和会话记录的 Codex 或 ChatGPT Work 桌面环境，或 Codex CLI；
- Node.js 18 或更高版本；
- Windows PowerShell 5.1 或更高版本用于剪贴板图片捕获；
- 本机 Claude Code CLI 已安装且完成登录；当前验证版本为 `2.1.258`；
- npm 用于运行项目脚本；插件运行时代码本身不依赖第三方 npm 包。

从源码：

```powershell
git clone https://github.com/yeyiwen2006/codex-claude-code-bridge.git
cd codex-claude-code-bridge
npm install
npm run check
node .\scripts\register-personal-marketplace.mjs
codex plugin add codex-claude-code-bridge@personal
```

安装或更新后都要新建 Codex 或 ChatGPT Work 本地任务；Hook 定义变化时要在 Codex App 的“设置”→“钩子”或 Codex CLI 的 `/hooks` 中重新审查并信任。本版本新增 `Interrupt` 并延长 `UserPromptSubmit` 的同步等待上限，因此更新后必须重新审查。

## 安全与数据

- 所有 Claude 进程都以当前 Windows 用户身份运行；插件不是 VM、容器或操作系统沙箱。
- `manual` 的审批对象是 Claude 当前真实请求的工具，而不是整个任务。
- `bypass` 允许 Claude 使用当前用户能使用的本机与网络能力，可能修改或删除项目外数据，也可能调用第三方插件和 MCP。
- 提示词、继承对话、图片路径和任务状态保存在本机插件数据目录；模型请求与已启用外部工具的数据会离开电脑。
- 不记录 Claude 身份令牌；后台 Claude CLI 继承正常 Claude Code 进程环境和认证来源。
- 详细威胁模型见 [SECURITY.md](./SECURITY.md)。

## 开发、验证与公开发布

```powershell
npm install
npm run check
```

测试覆盖 App/CLI 命令解析、单次提交去重、同步终态、长任务、超时、中断取消、工具审批、`AskUserQuestion`、空结果恢复、customizations 隔离、当前对话继承、多图队列、原生权限模式映射、bypass 无桥接器工具黑名单、权限提示 MCP、主 MCP 协议与 UTF-8 静态检查。

项目可以作为普通公开 GitHub 仓库发布。仓库不包含 Claude 登录凭据、用户图片、插件运行状态或项目数据。使用者仍需在自己的电脑安装 Claude Code、Node.js 与支持本地插件的 Codex 或 ChatGPT Work，并独立信任 Hook。

公开 GitHub 项目不等于 OpenAI 通用云插件。当前实现依赖本机 stdio MCP、Codex Hook、Windows 剪贴板和本地进程，不能原样作为云端 HTTPS MCP 服务运行。

## 许可证

本项目采用 [MIT License](./LICENSE)，版权所有 © 2026 Yiwen Ye（GitHub：[@yeyiwen2006](https://github.com/yeyiwen2006)）。
