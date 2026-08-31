# Claude Code Bridge

[English](./README.en.md)

Claude Code Bridge 是一个可公开发布到 GitHub、也可安装在个人电脑上的非官方 Codex 本地插件。它让用户在 Codex 聊天框里使用确定性的 `/claude` 命令直接调用本机 Claude Code，并提供一个可累积多张图片的 Windows 剪贴板队列。

这个项目不隶属于 OpenAI 或 Anthropic，也不捆绑 Claude Code、账号、订阅或 API Key。

## 两种调用路径

### 确定性命令路径

输入 `/claude ...` 时，插件的 `UserPromptSubmit` Hook 会在 Codex 模型启动之前解析并执行命令，然后阻止原提示词继续进入模型。

```text
Codex 聊天框
  → UserPromptSubmit Hook
  → 固定命令解析器
  → 本机 Claude Code CLI
  → Claude 的模型提供商
```

这条路径不会要求 Codex 模型理解命令，也不通过模型选择 MCP 工具。本项目的隔离测试确认，被 Hook 拦截的命令可以让 Codex 输入、输出和推理 token 都保持为 0。

Codex 当前公开 Hook 输出接口不能创建普通助手气泡，因此命令结果会以 Hook 阻止信息显示在当前任务中。较长的 Claude 输出会显示头尾预览，并把完整 UTF-8 文本保存到插件的私有数据目录。

### MCP 与 Skill 兼容路径

插件仍提供 `claude_code_health`、`claude_code_authorize_directory`、`claude_code_plan` 和 `claude_code_run`，供用户明确要求 Codex 模型协调 Claude 时使用。这条路径会使用 Codex 模型，不是 `/claude` 命令的默认实现。

## 多图直传

Codex 的 `UserPromptSubmit` Hook 只公开当前提示词文字，不公开本次尚未提交的图片附件。因此插件不尝试解析不稳定的 Codex 会话文件，而是读取用户刚刚粘贴图片时仍在 Windows 剪贴板中的原始数据。

单张图片：

```text
1. 在 Codex 聊天框粘贴图片
2. 发送 /claude image add
3. 发送 /claude image run -- 分析图片并修改对应代码
```

多张位图：

```text
粘贴第 1 张 → /claude image add
粘贴第 2 张 → /claude image add
粘贴第 3 张 → /claude image add
/claude image run -- 对比全部图片并完成任务
```

如果 Windows 剪贴板一次包含多个图片文件，例如在文件管理器中复制了多个 PNG/JPEG 文件，一次 `/claude image add` 会按剪贴板顺序全部加入队列。

图片行为：

- 队列按加入顺序保存，最多 20 张。
- 单张不超过 25 MiB，队列合计不超过 100 MiB。
- PNG 剪贴板流和文件复制保留原始字节。
- 剪贴板只提供 Bitmap 时，插件转成像素无损 PNG；原格式、EXIF 和其他元数据不保证保留。
- 重复检测使用 Windows 剪贴板序列号，不计算文件哈希。
- 同一剪贴板内容默认不会重复加入；确需重复时使用 `/claude image add --force`。
- 图片保存在 `PLUGIN_DATA` 下当前 Codex 任务的私有队列中。
- Claude 调用实际开始后，本次使用的图片会从队列删除；任务结束时也会清理剩余队列。
- `/claude image clear` 可以手动清空，但存在引用这些图片的待审批任务时会拒绝清空。

Windows 标准剪贴板通常只能同时保存一张裸位图，所以多次截图需要逐张粘贴并执行 `image add`。这种队列设计不会偷偷读取普通聊天中的剪贴板，也不会把旧图片自动附加到普通 `/claude run`。

## 命令

### 帮助和状态

```text
/claude help
/claude status
```

### 目录授权

```text
/claude access allow .
/claude access allow "C:\path\to\project"
/claude access show
/claude access revoke
```

每个 Codex 任务必须先明确授权项目根目录。授权经过真实路径规范化，有效期四小时。文件系统根目录、整个用户主目录和 Windows UNC 网络共享根会被拒绝。

### 运行 Claude

```text
/claude plan -- 分析当前鉴权流程，只给出方案
/claude run -- 修复登录错误并更新相关测试代码
```

当 `approval=ask` 且任务具有修改权限时，第一次命令只暂存任务：

```text
/claude run -- 实现这个改动
/claude approve a1b2c3d4
```

也可以取消：

```text
/claude cancel a1b2c3d4
```

待审批任务最多保留 15 分钟。提示词和设置快照只保存在本地插件数据目录，批准、取消、过期或任务结束后删除。

### 图片

```text
/claude image add
/claude image add --force
/claude image list
/claude image run -- 找出这些界面截图之间的差异并修复代码
/claude image skill reviewer:visual-check -- 检查三张截图
/claude image clear
```

### 设置

```text
/claude config show
/claude config set model sonnet
/claude config set model default
/claude config set effort high
/claude config set permission edit
/claude config set approval ask
/claude config set customizations plugin-only
/claude config set plugin-tools off
/claude config set timeout-seconds 1800
/claude config set max-budget-usd 5
/claude config set persist-session on
/claude config reset effort
/claude config reset all
```

设置保存在插件的本地私有数据目录，不写入项目仓库。

#### 文件权限

`permission` 可选值：

| 值 | Claude 模式 | 行为 |
|---|---|---|
| `plan` | `plan` | 只提供 Read、Glob、Grep |
| `edit` | `acceptEdits` | 提供 Read、Glob、Grep、Edit、Write |
| `locked` | `dontAsk` | 只预授权固定文件工具，其他请求直接拒绝 |
| `auto` | `auto` | 使用 Claude 的分类器，但仍只有固定文件工具；账号和模型必须支持 |

公开版本固定不向 Claude 提供 Bash、PowerShell、WebFetch 或 WebSearch，也不支持任何绕过权限模式。需要运行测试、构建或 Git 命令时，建议由 Codex 在自己的 sandbox 和审批策略下执行。

#### 桥接审批

`approval` 可选值：

| 值 | 行为 |
|---|---|
| `ask` | 修改任务先生成 8 位审批 ID，用户再发送 `approve` |
| `auto` | 目录已授权后立即启动修改任务 |
| `deny` | 拒绝所有具有修改权限的任务 |

这是一次 Claude 任务批次的审批，不是每个 Edit 的交互审批。非交互 `claude -p` 无法在 Codex Hook 中显示 Claude 自己的终端审批对话。

#### Claude 自定义配置

`customizations` 可选值：

| 值 | 加载内容 |
|---|---|
| `safe` | 使用 Claude `--safe-mode`，禁用用户和项目自定义项 |
| `plugin-only` | 不读取用户/项目 settings，只加载桥接器显式配置的 `--plugin-dir` |
| `user` | 加载 Claude 用户级 settings、Skills、插件和 Hooks |
| `project` | 加载当前项目与 local 设置 |
| `all` | 加载 user、project、local 全部来源 |

加载用户或项目自定义项可能执行 Claude Hooks、MCP 服务器或插件代码。只有在信任这些内容时才启用。

`plugin-tools=on` 允许已加载 Claude 插件贡献的 MCP 工具。它们可能访问网络或外部服务，因此与加载插件本身分开控制，默认关闭。

### Claude 插件和 Skills

```text
/claude plugin list
/claude plugin add "C:\absolute\path\to\plugin"
/claude plugin add "C:\absolute\path\to\plugin.zip"
/claude plugin remove 1

/claude skill list
/claude skill run simplify -- 检查刚才的改动
/claude skill run my-plugin:review -- 重点检查权限边界
```

`plugin add` 只把目录或 ZIP 加入桥接器的 `--plugin-dir` 列表，不复制、安装或删除插件。Claude 已安装的用户级插件也会显示在 `plugin list` 中；是否加载取决于 `customizations`。

Claude 插件 Skill 使用 `插件名:Skill名` 命名空间。`skill run` 会把 `/<skill-name>` 作为 Claude 提示词的开头直接交给 Claude CLI。普通 `run` 也允许 Claude 在已加载配置中按相关性自动选择 Skill。

### Claude 会话

```text
/claude config set persist-session on
/claude session show
/claude session fork
/claude session clear
```

默认不保存可恢复会话。启用后，桥接器只按 Claude 返回的精确 UUID 恢复，并绑定到同一授权根。它不使用容易串线的 `--continue`。Claude Code 自己可能在用户配置目录保存包含提示词、源码和工具结果的 JSONL 会话文件。

## 安全模型

- `/claude` 命令使用固定语法和参数数组，prompt 通过 stdin 发送。
- 启动进程使用 `shell: false`，不存在用户文本拼接成 shell 命令的路径。
- Claude 可执行文件解析为真实绝对路径，并在调用前验证版本输出标识为 Claude Code。
- 子进程只继承认证、代理、证书和基础操作系统所需的环境变量允许列表。
- 不接受 API Key 作为聊天命令或 MCP 参数，也不记录凭据。
- 同一时间只运行一个确定性 Claude 命令；MCP 路径限制为最多两个并发调用，并禁止重叠写目录。
- stdout 和 stderr 有大小上限，进程有超时和取消处理。
- 目录授权和文件工具白名单属于应用级防线，不是 Windows 操作系统沙箱。
- Claude 输出、项目文件、图片文字、Skills、Hooks、插件和 MCP 返回都可能包含提示词注入，仍需人工检查最终变更。

“本地插件”不表示“离线”。数据流可能是：

```text
用户
  → Codex 本地 Hook
  → 本机 Claude Code CLI
  → Anthropic 或用户配置的模型提供商
  → 已授权项目和已排队图片
```

自然语言 MCP 路径还会先经过 Codex/OpenAI。只应处理有权交给相应服务的数据。

## 安装

### 要求

- 支持本地插件和 Hooks 的 Codex。
- Node.js 18 或更新版本。
- 本机 Claude Code CLI；当前验证版本为 `2.1.220`。
- 用户自己的 Claude Code 登录或 Anthropic 凭据。
- Windows 10/11 用于聊天框直接粘贴图片；macOS/Linux 当前仍可使用文本命令与 MCP，但没有实现剪贴板图片捕获。

OpenAI 订阅不包含 Claude Code 用量。Claude 调用可能消耗 Anthropic 套餐额度或产生 API 费用。

### 从 GitHub 安装

公开仓库发布后，把 `<repository-url>` 换成真实地址：

```powershell
git clone <repository-url> "$env:USERPROFILE\plugins\claude-code-bridge"
node "$env:USERPROFILE\plugins\claude-code-bridge\scripts\register-personal-marketplace.mjs"
codex plugin add claude-code-bridge@personal --json
```

个人 marketplace 文件位于 `~/.agents/plugins/marketplace.json`。注册脚本只添加或更新本插件条目，保留其他条目，并在覆盖现有 marketplace 前创建备份。

安装后：

1. 新建一个 Codex 任务，让插件 Hook、Skill 和 MCP 服务器在启动时加载。
2. 使用 `/hooks` 审查并信任插件的 `UserPromptSubmit` 和 `SessionEnd` Hook。
3. 输入 `/claude status` 检查 Claude CLI 和认证。
4. 在目标项目里输入 `/claude access allow .`。

### 更新

```powershell
git -C "$env:USERPROFILE\plugins\claude-code-bridge" pull --ff-only
codex plugin add claude-code-bridge@personal --json
```

更新后新建 Codex 任务。

### 卸载

```powershell
codex plugin remove claude-code-bridge@personal
node "$env:USERPROFILE\plugins\claude-code-bridge\scripts\unregister-personal-marketplace.mjs" --yes
```

卸载脚本只移除个人 marketplace 条目，不删除插件源码、项目、Claude 配置、Claude 会话或凭据。

## 本地开发与验证

```powershell
node .\scripts\check.mjs
node --test
```

自动化测试使用假的 Claude 可执行程序和假的剪贴板捕获器，不消耗 Claude 额度，不修改真实项目，也不改变用户剪贴板。CI 在 Windows、macOS 和 Ubuntu 的 Node.js 18、20、22 上运行；Windows 剪贴板的真实集成测试需要用户在本机手动粘贴图片，因此不在公共 CI 中改写系统剪贴板。

## 公开发布范围

整个目录可以作为普通开源项目上传到 GitHub，MIT License 允许其他用户修改和再发布。每位使用者仍需在自己的电脑安装 Claude Code、完成认证并安装本地 Codex 插件。

公开 GitHub 仓库与 OpenAI 通用插件目录上架不是一回事。当前架构依赖本机 stdio MCP、Codex Hook、Windows 剪贴板和本机 Claude CLI，不能原样作为云端 HTTPS MCP 服务运行。

## 许可证

项目代码采用 MIT License，见 [LICENSE](./LICENSE)。Claude Code、Codex、OpenAI 服务和 Anthropic 服务继续受各自许可、条款和隐私政策约束。
