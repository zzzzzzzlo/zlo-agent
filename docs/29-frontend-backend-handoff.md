# 前端重构 · 后端功能与接口

适用基线为 `4b3fa3a`，桌面应用版本 `0.5.0`，桌面协议 `schemaVersion: 1`。本文面向重做 Electron Renderer 的开发者。类型和必填字段以 [共享契约](../shared/contracts/) 为准。

## 接入边界

`React Renderer → Preload → Electron Main → JSONL → Local Agent Host`

Renderer 通过 `window.agentHost`、`window.agentManagement`、`window.agentChatGpt` 调用业务接口。窗口最小化、最大化和关闭走 `window.desktopWindow`。Main 管 Host 进程、来源校验、原生授权和凭证。Host 管对话、任务状态、模型、工具权限、Pi Session 和 SQLite。前端可以缓存和投影数据，重连时以 Host 快照与事件为准。桌面接口均有固定的 Preload 方法，无需在组件中组装 IPC channel 或 JSONL 命令。 [Preload 实现](../ui/electron/preload/index.ts) · [现有聊天适配器](../ui/src/integrations/agent/HostAgentAdapter.ts)

## 页面与功能对照

| 页面或组件 | 已有后端能力 | 前端入口 |
| --- | --- | --- |
| 侧边栏与新建会话 | 列表、创建、重命名、归档、系统目录选择 | `agentHost` 的会话方法 |
| 对话、编辑器与工具卡 | 分页历史、流式文本、工具状态、追加指令、停止、恢复 | `getHistory`、会话事件及操作方法 |
| 对话工具栏 | 当前模型、待应用模型、会话权限 | `setConversationModel`、`setWorkspaceAccess` |
| 会话中台抽屉 | 当前会话累计 Token、估算成本、工具调用次数和最近任务预算 | `conversationObservatory` |
| API 接入与账号 | DeepSeek、OpenAI、Anthropic、Google 的凭证、连接测试和模型目录。独立的 ChatGPT 登录与登出 | `snapshot({})`、Provider 方法、`agentChatGpt` |
| 执行策略与工具 | 默认工作区权限、默认模型、自动或固定选模、工具开关、搜索 Provider | `snapshot({})`、`savePreferences` |
| 任务详情与异常核对 | 任务状态、DAG、Root/Team/Worker、用量、验收、操作回执、未知副作用探测 | `snapshot({ conversationId })`、`reconcile` |
| 会话记忆 | 事实、经验和最近召回摘要、删除选中条目 | `snapshot({ conversationId })`、`deleteMemory` |
| 诊断与应用状态 | 应用版本、脱敏诊断、Host 在线状态和重启 | `snapshot({})`、`recentDiagnostics`、`getStatus`、`onStatus`、`restart` |

## `window.agentHost` · 会话与执行

入参对象只传表中字段。会话 ID 和任务 ID 由 Host 返回。`requestId` 由客户端生成，推荐 `crypto.randomUUID()`。同一次写操作如果传输结果未知，使用相同入参和相同 `requestId` 重试；用户发起新的操作时生成新 ID。 `route` 的结构为 `{ provider, model }`。

| 方法 | 参数 | 返回值和行为 |
| --- | --- | --- |
| `getStatus()` | 无 | `DesktopHostStatus`。`state` 为 `starting`、`ready` 或 `offline`，`mode` 为 `pi`、`fake` 或 `faux`。 |
| `restart()` | 无 | 重启 Host，返回 `DesktopHostStatus`。Host 恢复 `ready` 后刷新会话列表与订阅。 |
| `chooseWorkspace()` | 无 | 已授权的本地目录字符串，取消返回 `null`。 |
| `createConversation(input)` | `{ requestId, title?, workspace?, workspaceAccess?, route?, check? }` | `ConversationSummary`。省略工作区时使用应用默认工作区。显式选择工作区时使用 `chooseWorkspace()` 返回的路径。 |
| `listConversations()` | 无 | `ConversationSummary[]`，只包含未归档会话。 |
| `getConversation(input)` | `{ conversationId }` | `ConversationSummary`，含实际与待应用路由、工作区和最新任务摘要。 |
| `renameConversation(input)` | `{ conversationId, requestId, title }` | 更新后的 `ConversationSummary`。 |
| `archiveConversation(input)` | `{ conversationId, requestId }` | 归档后的 `ConversationSummary`。历史保留。 |
| `getHistory(input)` | `{ conversationId, before? }` | `ConversationHistory`，含 `conversation`、`turns`、`cursor`、可选 `nextBefore`。每页最多 50 轮。 |
| `sendMessage(input)` | `{ conversationId, requestId, text }` | `{ taskId, taskRunId }`。创建新一轮 Task，文本上限 16,000 字符。 |
| `steerConversation(input)` | `{ conversationId, taskId, requestId, text }` | `{ accepted: true }`。为当前任务追加说明，文本上限 8,000 字符。接受后进入后端传递队列。 |
| `stopConversation(input)`、`resumeConversation(input)` | `{ conversationId, taskId, requestId }` | `{ accepted, status }`。以返回值和后续事件更新界面。 |
| `setConversationModel(input)` | `{ conversationId, requestId, route }` | `ConversationSummary`。`route: null` 撤销待应用切换。已有会话仅支持同 Provider 切换，Host 在安全边界应用。 |
| `watchConversation(input)`、`unwatchConversation(input)` | 前者 `{ conversationId, after }`，后者 `{ conversationId }` | 返回 `true`。`after` 为排他游标。 |
| `onEvent(listener)`、`onStatus(listener)` | 分别接收 `ConversationEvent` 和 `DesktopHostStatus` | 返回移除监听器的函数。卸载时调用。 |

`ConversationSummary` 中的 `route` 是当前路由，`pendingRoute` 用于显示“待应用”。收到新的权威摘要后更新两个字段。Provider 不同的模型可以在新会话选择。修改全局默认模型不等于替已有会话切换 Provider。

工作区权限为 `read`、`write`、`trusted`。`write` 允许在授权范围内修改文件，验收条件可省略。显式指定 `write` 或 `trusted` 创建会话时须带已选工作区。文件验收用 `check: { path, contains? }`，路径相对工作区。Trusted 工作区可用 `check: { command: { command, path, args? } }`，命令名是 `npm_test`、`npm_build`、`npm_lint`、`npm_typecheck` 或 `node_script`，只有 `node_script` 支持 `args`。这套接口用于项目验收，任意 Shell 属于另一条受审批的工具链。 [输入验证](../ui/electron/main/agent-input.ts) · [共享会话类型](../shared/contracts/desktop.ts)

### 历史、增量与重连

1. 启动时订阅 `onStatus` 并获取 `getStatus()`。Host `ready` 后加载会话列表，按需打开会话。
2. 打开会话时先绑定事件监听并暂存该会话事件，再取 `getHistory({ conversationId })`。合并快照后以其 `cursor` 订阅 `watchConversation({ conversationId, after: cursor })`，随后按 `seq` 应用暂存事件。
3. `seq` 在同一会话内递增。忽略 `seq <= cursor`。遇到缺口或 Host 重连时重新取最新快照并重新订阅。分页用上一页的 `nextBefore` 原值，按 `taskId` 合并已加载的早期记录。加载旧页时保留当前直播游标和较新的轮次状态。
4. 会话切换或卸载时释放旧监听和订阅。需要保留后台活动状态时，由一个全局适配器统一订阅对应会话。

| 事件 | 使用方式 |
| --- | --- |
| `conversation.created`、`conversation.updated`、`conversation.archived`、`conversation.permissions_changed` | 使用 `payload.conversation` 更新会话摘要。 |
| `conversation.model_requested`、`model.route_changed` | 刷新 `route` 与 `pendingRoute`。 |
| `message.created`、`task.created`、`task.updated` | 合并 `payload.turn`。一轮以 `taskId` 为键，`taskRunId` 和 `taskAttemptId` 用于标识执行与尝试。 |
| `message.delta`、`message.completed` | 按 `messageId` 更新助理消息，只拼接已去重的增量。 |
| `tool.started`、`tool.updated` | 按 `payload.tool.id` 更新调用卡片。`assistantOffset` 是工具开始时助理累计文本的 UTF-16 长度。聊天按该位置插入工具组，旧数据没有位置时集中显示在回复前。`reason` 是可选的失败类别。 |
| `agent.started`、`agent.finished`、`task.node_updated` | 更新节点和 Agent 的运行投影。完整 DAG 来自管理快照。 |
| `model.usage` | `payload.usage` 是该轮当前累计值，直接覆盖对应累计字段。 |
| `run.finished`、`run.interrupted` | 展示运行结束状态与原因，可刷新任务详情和会话中台。 |

不认识的事件类型可以跳过渲染，同时推进有效游标。前端可以沿用现有快照合并与订阅实现。 [HostAgentAdapter](../ui/src/integrations/agent/HostAgentAdapter.ts) · [Conversation 投影](../ui/src/integrations/agent/conversationProjection.ts) · [现有会话 Store](../ui/src/stores/workspace.ts)

### 状态与操作

| Task 状态 | 推荐界面行为 |
| --- | --- |
| `ready`、`running`、`verifying` | 分别显示排队、执行、验收。运行中追加指令使用 `steerConversation`。是否接受以 Host 结果为准。 |
| `stop_requested`、`stopping` | 显示“停止中”，等待 Host 完成取消和保存检查点。 |
| `stopped`、`blocked` | 显示原因。允许用户尝试恢复，按 `accepted` 与最新事件更新。 |
| `needs_reconciliation` | 展示未知操作回执与核对入口。核对完成后重新读取任务状态。 |
| `succeeded`、`failed` | 展示执行结果和单独的验收结论。使用 `verification.verdict` 或共享的 `verificationVerdict()` 处理旧数据。 |

验收结果有 `verified`、`unverified`、`failed`、`not_applicable`。`succeeded` 表示 Task 已完成，可能仍为 `unverified`。工具 `succeeded` 只说明该次工具操作成功。 [任务与验收类型](../shared/contracts/domain.ts)

聊天按 Markdown 渲染助理文本。原文继续用于历史和游标回放。工具事件独立于文本，工具组可展开。验收结论显示在会话中台和任务详情，验收失败也可在聊天看到。布局参考 Codex 的消息渲染和工具活动分离。 [Codex 消息渲染](https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/messages.rs) · [Codex 运行活动](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/turn_runtime.rs)

## `window.agentManagement` · 工作台

| 方法 | 参数 | 返回值和行为 |
| --- | --- | --- |
| `snapshot(input)` | `{ conversationId?: string }`，全局页传 `{}` | `ManagementSnapshot`，含版本、偏好、Provider、工具、脱敏诊断。指定会话时还返回会话摘要、最多 20 个最近任务和作用域内记忆。 |
| `conversationObservatory(input)` | `{ conversationId }` | `ConversationObservatory`，含总轮数、四类 Token、模型请求和用量覆盖、估算费用、工具状态计数及可选最近任务预算。 |
| `recentDiagnostics()` | 无 | `ManagedDiagnostic[]`，含时间、模块、类别、错误码、摘要和 `correlationId`。 |
| `savePreferences(input)` | 完整 `AgentPreferences` 对象 | 保存后返回偏好。先读取快照再按字段合并，放宽策略可能弹出原生确认。 |
| `setWorkspaceAccess(input)` | `{ conversationId, access }` | 更新后的 `ConversationSummary`。提升需要 Main 确认工作区，运行中先停止才能提升。收紧会让活动任务收敛。 |
| `setProviderKey(input)` | `{ provider }` | `ManagedProvider`。Main 弹窗确认后读取剪贴板、核验并加密保存。 |
| `testProvider(input)` | `{ provider, model? }` | `ManagedProvider`。`model` 为该 Provider 的模型 ID，省略可测试账号配置。 |
| `removeProviderKey(input)` | `{ provider }` | `ManagedProvider`。原生确认后删除本地凭证，相关任务可能停止。 |
| `deleteMemory(input)` | `{ conversationId, ids }` | 删除条数。最多传 96 个记忆 ID，操作需确认。 |
| `reconcile(input)` | `{ conversationId, taskId, operationId }` | `ManagedOperation`。Host 观察文件或进程等现状并返回证据，`reconciliation.status` 为 `verified` 或 `unresolved`。 |

`AgentPreferences` 包括 `workspaceAccess`、`defaultRoute`、`modelSelection`（`automatic`/`fixed`）、`disabledTools`、`searchProvider`（`hacker_news`/`brave`/`disabled`）。Brave 依赖 Host 本地配置，`braveConfigured` 表明配置可用。当前可用模型选项来自 `providers[].models[]`，`ManagedProvider.connection` 与 `credential` 分别表达连接结果和凭证来源。API Key 的添加按钮只发送 Provider ID。工具审批、文件导出目的地、权限提升和凭证捕获由可信 Main 完成。

`ManagedTask.nodes[].dependencies` 表达任务依赖，`parentNodeId` 表达委派层级，`agents[].parentId` 表达 Agent 层级。DAG 和 Agent Tree 应分别绘制，用 `nodeId` 关联。`ManagedTool` 的角色字段用于目录展示，实际执行仍按本次委派、工作区与审批校验。核对返回 `unresolved` 时保留阻塞提示。Git 现状、原进程 PID 是否存在等证据通常不足以证明副作用结果。 `operationId` 从快照的 `operations[].id` 读取。

中台面板的 `usage` 包括 `input`、`output`、`cacheRead`、`cacheWrite`。按各类别展示，汇总时每类只计算一次。`estimatedCostUsd: null` 表示没有可用估算。`usageReports` 和 `pricedReports` 反映覆盖情况，局部估算要标明口径。`confirmed`、`reserved`、`uncertain` 是任务内部预算状态。供应商剩余额度当前没有查询接口。 [管理与中台类型](../shared/contracts/management.ts) · [Main 管理 IPC](../ui/electron/main/management-ipc.ts)

## `window.agentChatGpt` · 独立账号授权

| 方法 | 参数 | 返回值和行为 |
| --- | --- | --- |
| `status()` | 无 | `ChatGptStatus`，含授权状态、账号标签及模型。 |
| `signIn(input)` | `{ profileId?: string }`，首次登录传 `{}` | 通过系统浏览器授权，返回更新后的 `ChatGptStatus`。 |
| `cancelSignIn()` | 无 | 取消等待中的登录。 |
| `signOut()` | 无 | 返回登出后的 `ChatGptStatus`。若有 `remoteRevocationConfirmed` 则按实际值展示。 |

UI 根据独立账号 API 的 `status()` 判断可用性和账号状态。`ManagementSnapshot.account` 是 Host 管理投影的占位字段。ChatGPT 账号模型取自 `ChatGptStatus.models`，与 OpenAI API Key 分开呈现。登录失败、取消和需要重新授权均应保留可恢复状态。访问令牌仅留在可信进程。 [账号类型](../shared/contracts/chatgpt.ts)

## Host 已有能力及 Renderer 可见范围

| 能力 | 当前接口边界 |
| --- | --- |
| 文件、Shell、Git、Web、浏览器、`preview_page`、`view_image`、产物导出 | Agent 在 Host 内调用。UI 可展示工具目录、调用状态和管理回执。`ConversationTool` 不含工具原始参数、Shell stdout 或截图字节。若设计产物预览页，需要新增受控读取接口。 |
| Root、Team、Worker 的委派、并行 DAG 和 Worktree | UI 可查看投影。会话控制接口操作当前 Task；单独停止 Worker、手动编辑会话 DAG 等没有桌面接口。 |
| Skills、快速/质量模式和高级预算 | 由 Host 在启动或 Run 内应用。当前桌面偏好接口没有设置 Skills、模式或预算的字段。 |
| 独立 Observatory / Evaluation | 独立本地 Web 服务，读取 Host 遥测并管理评估。会话中台抽屉的 `conversationObservatory` 聚合可直接工作，无需启动独立服务。 |
| CLI 的独立任务、JSONL 和凭证引导命令 | 独立任务与桌面会话是不同入口。私有的启动、凭证和工具审批命令由 Main 或 CLI 执行，Renderer 以 Preload 声明为准。 |

参考 [工具系统](18-tool-system.md)、[Harness 与能力委派](27-harness-alignment.md)、[独立中台](23-observatory.md)、[桌面 JSONL 协议](11-desktop-protocol.md)。

## 错误与重构验收

- 桌面 IPC 失败通常以 Promise rejection 传回，消息包含 `[INVALID_INPUT]`、`[NOT_FOUND]`、`[CONFLICT]`、`[MODEL_UNAVAILABLE]`、`[HOST_UNAVAILABLE]` 或 `[INTERNAL]`。保留无法识别时的通用错误状态。取消原生弹窗也可能返回 `CONFLICT` 或 `INVALID_INPUT`。
- 模型切换、权限调整和账号操作结束后使用返回的权威状态，拒绝后保留原显示并给出重试或取消出口。`HOST_UNAVAILABLE` 时显示离线和重启入口。路径、Token 和诊断中的未知字段保留缺失语义。
- 对话回归覆盖历史分页、重连、流式消息、运行中追加、停止及恢复、同 Provider 切换、跨 Provider 拒绝和待核对状态。工作台回归覆盖目录选择、Trusted 确认、Key 捕获、Token 和工具统计。
- 视觉开发可以用显式 Mock 模式先检查布局，完整交互验收用真实 Electron 和离线 Faux Provider。运行 `npm.cmd --prefix ui run typecheck`、`npm.cmd --prefix ui test` 和 `npm.cmd --prefix ui run test:desktop`。 [UI 启动方式](../ui/README.md) · [Electron E2E](../ui/test/desktop-e2e.test.mjs)
