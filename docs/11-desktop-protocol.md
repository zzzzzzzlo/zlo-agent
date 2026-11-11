# Sprint 4 · 桌面协议与实施顺序

本页保留 Sprint 4 基线。当前权限、验收和管理命令见 [0.5.0 桌面协议](21-desktop-management.md)。

Phase 0 核对：本地 main 与 origin/main 指向首轮 877b4ef，工作区干净。Node 24.15.0，Electron 43.4.1。Host 基线 31/31，UI 类型检查通过。首轮只有 Task 级事件、临时输出及按 Task 划分的 Pi 会话，桌面使用 Mock 与 localStorage。未发现可用于在线测试的 Provider 环境变量。

Phase 1 冻结接口在 `shared/contracts/domain.ts` 与 `shared/contracts/desktop.ts`。以下约定先于并行开发。

- Electron → Host 使用原 JSONL stdin/stdout。新命令使用 `DesktopCommand`，结果沿用 `{schemaVersion:1, kind:"result", commandId, type, result}`。事件为 `{schemaVersion:1, kind:"conversation.event", event}`。错误为 `{schemaVersion:1,kind:"error",commandId,error:{code,message}}`，旧 CLI 保留顶层 message。启动 `ready` 包含 mode。CLI `exit` 正常停止，EOF 作为关闭保护。
- Electron Main 管生命周期和 transport，Preload 仅暴露 `window.agentHost: DesktopHostApi`。可信窗口通过本地目录选择器授权工作区。Renderer 的写命令不能传入其他工作区路径。
- 新 Conversation 绑定工作区、可选模型和可选验收。0.5.0 的工作区授权与验收独立，文本回复与工具回执分别记录执行事实。
- 新消息创建独立 Task，与消息原子落盘。每个 Task 首次创建时分配 TaskRun ID。显式用户停止后重试有新 Attempt，进程中断且状态可核对的连续恢复沿用该 Attempt。Worker Attempt 独立，沿用根 TaskRun。首次跨版本写入保留旧事件原样并补充旧任务的稳定 Run ID。
- 当前 Pi Session 归 Conversation，上下文独立于 UI 和 Task。根 Agent 激活产生新的 AgentRun。Worker 有独立 Pi Session 与 Context Package，不接收完整父对话。
- History 提供按 Task 聚合的用户消息、助理消息、工具摘要、状态、Usage 与独立 ID。每条消息有独立 ID。Conversation 事件序号独立且可从 History cursor 排他性补读。message.delta 先持久化回复片段再发出，其余事件可带当前投影。History 和 cursor 从同一同步快照读取。
- 单个 Conversation 同时最多一个未结工作。停止后可以继续或发送新目标，needs_reconciliation 阻止复用该会话执行。归档保留 SQLite 审计历史并从列表隐藏，活动任务先结束。
- 依赖顺序为契约 → Host、Electron、前端并行 → 真实 Electron + Faux 集成 → 源码审查与验收记录。生产 Host 默认 Pi，Faux 仅供显式测试，Mock 仅供显式界面演示。

## 桌面命令

所有变更命令接收 `requestId`。传输用 `commandId` 关联请求和响应，重试同一业务操作时可保留 `requestId` 并使用新 `commandId`。事件不会以命令应答的形式返回。

| Wire 命令 | 参数与结果 |
| --- | --- |
| `createConversation` | `requestId`，可选标题、经选择器授权的工作区、路由和相对文件检查。返回 Conversation 摘要 |
| `listConversations` | 返回未归档 Conversation 摘要 |
| `getConversation` | 按 `conversationId` 返回摘要、当前 Session 引用和最新 Task 状态 |
| `getConversationHistory` | 按 `conversationId` 读取最多 50 轮，返回按时间排列的 `turns` 及 `cursor`。`before` 排除相应轮次，使用 `nextBefore` 继续翻页 |
| `sendMessage` | `conversationId`、`requestId` 和 `text`。返回独立的 `taskId` 与 `taskRunId` |
| `steerConversation` | 对当前 `taskId` 追加 `text`，在接受后持久化并在可用时送入 Pi 的 steering 队列 |
| `stopConversation`、`resumeConversation` | `conversationId`、`taskId`、`requestId`。返回接受结果与当时状态 |
| `setConversationModel` | `conversationId`、`requestId`、`route`。路由为 null 时撤销待应用请求。返回会话摘要 |
| `renameConversation`、`archiveConversation` | 按 `conversationId` 更新摘要，归档保留历史 |
| `subscribeConversation`、`unsubscribeConversation` | 按会话订阅或移除订阅。订阅的 `after` 排除该序号 |

Preload 将 `getHistory`、`watchConversation`、`unwatchConversation` 映射到上述 wire 命令，另提供本地目录选择、Host 状态和重启。Renderer 只接收 DTO。

## 持久事件

`eventId` 全局唯一，`seq` 在 Conversation 内递增，`timestamp` 为 Unix 毫秒。关联字段可包含 Task、TaskRun、Attempt、AgentRun、父 AgentRun、Node 和 Pi Session。历史快照的 `cursor` 是当时最后一个已提交的事件序号。

| 事件 | 数据 |
| --- | --- |
| `conversation.model_requested`、`model.route_changed` | 请求或已应用路由的会话摘要 |
| `conversation.created/updated/archived` | Conversation 摘要 |
| `message.created` | 持久用户消息或追加说明、关联 Task 与当前轮次 |
| `message.delta` | 助理消息 ID 与持久文本增量 |
| `message.completed` | 完成的助理消息引用与状态 |
| `task.created/updated` | Task 状态及当前轮次投影 |
| `agent.started/finished` | 独立 AgentRun 身份、角色与状态 |
| `tool.started/updated` | 工具名、调用 ID、AgentRun 和执行状态 |
| `model.usage` | 当前轮累计输入、输出及缓存用量 |
| `run.interrupted/finished` | 结束状态及可选原因 |

Pi 消费追加指令后由 SDK 事件确认，Host 在会话检查点刷盘后核销。尚未确认的追加说明留作恢复时的待处理指令。未确认的文件写入进入人工核对，拒绝同一 Conversation 继续执行。

模型配置区分 `route` 与 `pendingRoute`。创建后尚未建立 Session 时可设置首选路由。已有 Session 的换模在后续自然的 Pi 轮次或下一条用户消息应用，沿用原 Pi Session。换模不单独发起模型请求。跨 Provider 以及会话正在打开、停止、待核对时的请求会被拒绝。
