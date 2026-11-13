# 工具系统扩展 · 实施与验收

## 0.3.0 基线与缺口

基线为 `9bbf5e9`。Host 已具备 Capability Plugin、受控文本工具、项目命令、Git 查询、Task DAG、SQLite 回执和桌面工作区授权。短项目命令只在退出后返回结果，缺少长进程句柄、精确多文件修改、隔离写入、外部信息工具和单文件导出。

实施顺序依次为统一执行与授权契约、独立插件、Worktree DAG 与桌面接入、回归及 Windows 验收。Pi SDK 和业务模块的状态权威保持原有边界。用 Codex 的进程启动与输出游标划分长进程生命周期，借鉴 DSH 的持久事件和恢复处理，并用 Claude Code 的公开权限设计区分工具授权与系统隔离。[Codex Exec Server](https://github.com/openai/codex/tree/main/codex-rs/exec-server) · [Codex Patch Runtime](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/runtimes/apply_patch.rs) · [DSH 持久化](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md) · [Claude Code 权限](https://code.claude.com/docs/en/permissions) · [Claude Code 沙箱](https://code.claude.com/docs/en/sandboxing)

## 工具与授权

| 能力 | 工具 | 授权和限制 |
| --- | --- | --- |
| Shell 与进程 | `shell_exec`、`process_status`、`process_output`、`process_stop` | 受信任的完整工作区。子节点需明确获准使用对应工具。逐次确认完整命令。Windows 支持 PowerShell 和 CMD。由本次 Agent Run 持有句柄。 |
| 文件搜索 | `search_files`、`search_content` | 使用当前可读范围，支持 Glob 和正则搜索，限制遍历、字节、匹配结果及正则运行时间。 |
| 文件修改 | `apply_patch`、`move_file`、`rename_file`、`delete_file` | 当前写入范围覆盖所有源和目标。Patch 预检精确内容，单文件通过临时文件提交。部分完成需要核对。移动拒绝覆盖，删除仅允许单个文件且逐次确认。 |
| Git | `git_branch`、`git_commit`、`git_worktree`、`git_merge` | 受信任的完整工作区，逐次确认。子节点的 Git 操作限于自身分配的工作区。Task 级 Worktree 分配和集成由 Host 管理。 |
| Web | `web_search`、`web_fetch` | 子节点需获得明确工具授权。对外发送搜索词或 URL 前确认。HTTPS 验证地址和重定向，请求绑定已验证的公共 IP。 |
| 浏览器 | `browser_open`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_scroll`、`browser_screenshot`、`browser_wait`、`browser_close` | 使用 AgentRun 专属上下文。只读权限可打开已授权的本地页面并截图。公共网页要求 Trusted 和网络确认。点击和输入另行确认。保存截图需要路径写入权限。 |
| 本地视觉 | `preview_page`、`view_image` | 在授权范围内离线渲染本地 HTML 或读取图片，向视觉模型返回受限图像。 |
| 导出 | `export_artifact` | 需要写入及相应工具授权。原生保存对话框授权一个新文件，限制本地路径和 32 MiB，拒绝覆盖及 Host 私有目录。 |

子节点的有效能力是用户授权、父节点权限和本次委派的交集。带多个文件参数的工具会校验所有路径。Worktree ID 由 Host 签发并核对 Git 注册，只有不同 Worktree 的写节点可同时执行。根节点确认各分支提交后再合并。共享工作区的写入仍然串行。详见 [Harness 与能力委派](27-harness-alignment.md)。

## 回执与停止

- `tool.approval_resolved` 持久化工具名和同意结果。原始审批参数和导出绝对路径只通过 Host 和 Electron Main 的临时通道，Preload 与 Renderer 无审批回包权限。
- `tool.started` 在副作用前落盘。长进程带 `managed`，原回执在进程退出及输出关闭后结算。它存续时仅同一 Run 的进程查询、读输出和停止工具可通过 Gate。
- `tool.finished` 记录结算状态，未知副作用进入 `needs_reconciliation`。重启后不沿用系统 PID 或自动重复命令。既有 Task 和 Conversation Cursor 保留。
- 隔离节点的 `task.node_started` 记录 Worktree ID，Task 历史的操作回执也保留归属 ID。工作目录和操作正文不进入常规诊断日志。

## 隔离边界

工作区和 Worktree 提供路径、文件与调度边界。Shell 和 Git 使用本地账号权限执行，Windows 受控进程树尝试有界终止。结果不明确的进程、Patch、导出或 Git 操作需要人工核对。

浏览器使用单独的临时上下文，不携带日常配置、认证状态或 Cookie。通过受控代理与 Host 固定地址请求加载网页，禁止脚本、WebSocket、Service Worker、上传、表单提交及非 GET 流量。支持公共静态页面的交互和截图。Windows 需要系统 Microsoft Edge。浏览器配置隔离与网络访问策略是应用约束，不提供系统级沙箱。

搜索、网页、文件内容和命令输出均作为不可信数据。工具返回限制长度并脱敏已知凭证。搜索和打开网页的原生确认明确展示本次将发送的内容。

默认搜索 Provider 为无需凭证的 Hacker News/Algolia，覆盖其收录的新闻与文章。配置进程环境变量 `ZLO_AGENT_BRAVE_SEARCH_API_KEY` 后使用 Brave Search 的通用网页搜索。搜索凭证只发送给固定的 Provider HTTPS 地址。Provider 接口可由受信任的 Host 集成者替换。

Git Worktree 从已提交的 HEAD 创建，保留当前 Task 的归属记录。节点以文件工具和文件检查验收，主工作区的未提交修改不会自动复制到 Worktree。Root 显式提交并批准合并后集成产物，保留 Worktree 供核对。Git 作者身份需要在本地仓库配置。

Host 冷启动握手限时 45 秒，以容纳 Windows 初次加载 SDK 与工具依赖。工具执行本身仍使用各自的超时和任务预算。

## 参数与返回

| 工具 | 主要参数 |
| --- | --- |
| `read_text_file` | `path`，可选 `startLine`（从 1 开始）和 `lineCount`（最多 200 行）。省略时读取原有的完整文本。 |
| `shell_exec` | `shell`、`command`、可选 `path` 与 `timeoutMs` |
| `process_status / process_stop` | 本次 Run 签发的 `processId` |
| `process_output` | `processId`、可选 `after` 与 `limit` |
| `search_files` | `path`、`glob` |
| `search_content` | `path`、`glob`、`query`，可选 `regex` 与 `caseSensitive` |
| `apply_patch` | `edits: [{path, oldText, newText}]`，每次最多 16 段，可对同一个现存文件提交多个互不重叠的片段 |
| `move_file / rename_file / delete_file` | `path`，移动另加 `destination`，改名另加 `newName` |
| `git_branch / git_worktree / git_merge` | `branch` |
| `git_commit` | `paths`、单行 `message`、可选当前 Task 的 `worktreeId` |
| `web_search / web_fetch` | 分别为 `query, limit?` 与 `url` |
| `browser_open` | 本地 `path` 和可选 `assets`、`width`、`height`，或公共 HTTPS `url`。返回 `browserId` |
| 其余浏览器工具 | `browserId`，另按工具接受 `selector`、`text`、`pixels`、`path` 或 `timeoutMs` |
| `export_artifact` | 工作区相对 `path`。目的地通过原生保存授权单独绑定 |

各参数的完整 JSON Schema 位于插件定义。返回值包含 `ok`，失败带固定错误摘要。进程输出携带有序 Cursor 与截断状态，进程状态保留实际退出码。网页、搜索和浏览器文本标明不可信来源。写操作的未知结果通过持久化回执及 Task 状态表示。

`apply_patch` 在每个文件的原始快照上定位全部片段。`oldText` 须精确匹配一次，包括空白。找不到、匹配多次或片段重叠时，错误指出对应的输入序号，整批在写入前退出。通过预检后，每个文件只替换一次。如果跨文件提交时遇到文件被其他程序修改或 I/O 中断，已开始提交的操作仍按现有回执进入核对流程。批量匹配的设计参考 [Pi Edit](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/edit.ts)，部分提交处理参考 [DSH Patch](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs/README.md#failures-and-recovery)。

`edit_text_file` 和 `apply_patch` 遇到匹配失败时可返回 `readRange: { startLine, lineCount }`。只有按行忽略首尾空白后得到唯一位置时才提供该提示。模型可用 `read_text_file` 重新读取这些行，保留缩进与原始换行，再用精确文本重试。精确匹配多次时返回前两处的 `matchLines`，用于补充定位上下文。失败提示不携带文件正文。
