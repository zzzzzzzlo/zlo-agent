# 02 · 总体架构与依赖方向

参阅 `../diagrams/system.mmd`。

## 逻辑划分

### 交互层
Desktop UI / local Web UI：发送命令（创建任务、追加说明/任务、停止/恢复、请求热切换）；订阅事件流（流式消息、状态、用量）；不直接接触 Pi Session 文件和业务表。

### 应用控制层
- `TaskEngine`：Task/TaskAttempt、动态 DAG、状态与验收、恢复计划；**唯一 Task 状态写入者**。
- `MultiAgentOrchestrator`：Agent Tree、Team/Worker、消息、上下文请求、委派与收敛。**不写 Task 状态表**。
- `ModelResourceScheduler`：可用模型及 Route、授权/能力、预算预留、热切换策略。**不依赖 Observability 的实时数据库**。
- `ContextBuilder`：按权限从 Task、Artifact、Memory 等接口收集上下文，记录源版本，施加 Token 预算。
- `CapabilityService`：向 Agent 暴露可用工具，同时在真正执行时做授权校验。

### 执行层
- `AgentExecution`：在 Pi SDK 中创建、恢复、关闭单个 Agent Session；管理本次 Run，适配 Pi 事件。
- `ToolExecution`：标准工具、可插拔 Plugin、操作效果确认。
- `WorkspaceManager`：工作目录与变更集成接口；本轮可使用单工作区且**限制并发写入**，或实现简单的 Worktree Adapter；不得做假沙箱。
- `Verification`：运行可确定验证器（测试、退出码、文件存在性/差异等），为 Task Engine 提供证据；LLM Review 只是补充而不是唯一依据。

### 独立能力与旁路
- `MemoryCore`：长期记忆事实/经验；只经 port 提供读写。
- `JudgmentKernel`：带 rule baseline 的判定服务；shadow 结果不改变行为。
- `AgentObservability`：只读消费事件，计算监控数据，后续独立评测。
- `EventBus`：状态事件+流式事件的统一协议；**控制命令与只读观察事件区分**。

## 数据归属

| 数据 | 权威组件 | 本地持久化建议 |
|---|---|---|
| Task、TaskAttempt、依赖、验收、Stop Intent | TaskEngine | SQLite |
| Pi 对话/工具历史 | Pi AgentExecution | Pi SessionManager 或已验证 durable adapter |
| Agent identity、父子关系、执行运行状态 | Orchestrator | SQLite，通过 Port 维护 |
| 事件日志 / 出站通知 | Event Store / Host | SQLite append-only/outbox，供订阅与回放 |
| 任务产物与 Diff 引用 | ArtifactStore | 文件系统 + SQLite 元数据 |
| 长期事实与经验 | MemoryCore | 独立 SQLite 命名空间，按作用域存储来源和版本 |
| Provider Route/资源容量/预算预留 | ModelResourceScheduler | SQLite/Provider Adapter |
| 评测结果和统计视图 | Observability | 独立投影，不是业务状态权威 |

## 进程边界

V0：模块化单体 `Local Agent Host` + 解耦 UI（终端 CLI 或 localhost Web UI）。

将来拆进程时保留 Command API 与 Event API。没有必要第一阶段拆微服务。SQLite 通过仓储接口封装，提交事件的事务边界需清晰；避免跨模块多数据库分布式事务。

## 待验证的 Pi 选项（阻塞实现选型，不阻塞架构）

1. 稳定 SDK `@earendil-works/pi-coding-agent`，官方 `createAgentSession`、`SessionManager`、`subscribe()`。
2. 实验性 `@earendil-works/pi-durable`：包括持久任务、子任务、任务图、恢复与用量；README 明确标注 **Experimental，API 可能无通知变更**。它可能替代部分 TaskEngine/Execution 实现，但**不能假设可直接作为常规 Coding Agent SDK 的即插即用插件**。
3. 第一阶段先做可运行的 compatibility spike，比对是否保持现有 Coding Tool/Extension/Session 功能、恢复语义及迁移成本，再给出 ADR 选择：采用 durable（必须锁版本+适配层）或稳定 SDK + 独立 TaskStore。

原则：不因为上游已有 Task Graph 就在应用层重复造第二个“权威 Task 状态”，如果选 durable，明确是以 durable task records 为存储底座，应用层只封装业务 DAG/验收；如果选稳定 SDK，则自建可持久化 TaskEngine。

## Sprint 4 桌面进程与身份边界

当前主入口是 Electron → Preload → Main → JSONL → LocalAgentHost。Conversation Service 拥有长期对话、消息和历史视图。Task Engine 拥有业务 Task、稳定 TaskRun 及 Attempt。Orchestrator 拥有 AgentRun 与 Pi Session 引用。Renderer 消费统一快照与事件，领域状态及历史由 Host 保存。详见 [桌面协议](11-desktop-protocol.md) 和 [运行架构](../diagrams/system.mmd)。
