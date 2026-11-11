# 中台数据契约 · 第三轮

使用 Host JSONL 的 `listTasks` 发现任务，并用 `events(taskId, after)` 回放或 `subscribe(taskId, after)` 续订。同一 Task 的 `seq` 单调增长，从客户端最后持久化的 Cursor 续读，按 `id` 去重。Task 间无全局序号。桌面使用独立的 Conversation 事件流和 Cursor。消息增量与完整对话只供有权限的桌面会话使用。

独立中台使用 Host 可选的回环只读端口。`GET /v1/tasks` 分页发现任务，`GET /v1/tasks/:id` 返回脱敏 DAG 和尝试快照，`GET /v1/tasks/:id/events?after=` 返回最多 128 条投影事件，`POST /v1/watch` 等待已知 Task 游标发生变化。完整取证由 `POST /v1/tasks/:id/evidence` 独立授权访问。启动、指标和证据边界见 [Zlo Observatory](23-observatory.md)。

## 公共信封

`schemaVersion` 当前为 1。每条事件包含 `id`、`seq`、`occurredAt`、`taskId`、`type`、`payload`。按事件来源附带 `taskRunId`、`taskNodeId`、`taskAttemptId`、`agentId`、`agentRunId`、`parentAgentRunId`、`sessionId`、`correlationId` 和 `causationId`。字段缺省时由消费者保留未知值。业务事件入库后再通知订阅方，订阅方故障隔离。

| 事件 | 数据与投影 |
| --- | --- |
| `task.created`、`task.state_changed`、`task.stop_requested`、`task.stopped`、`task.resumed` | 状态、原因、时间。按 Run/Attempt 计算完成、停止、阻塞率和时长。 |
| `task.plan_changed`、`task.node_started`、`task.node_settled`、`task.worker_settled` | 计划版本、节点、父节点、角色和依赖标识。结算事件携带状态及可用的验收和证据引用。用 `getTask` 获取权威 DAG 快照。 |
| `agent.started`、`agent.finished` | 角色、开始路由、父 Agent、Run/Session、完成状态、生命周期和证据计数。Team 进入 idle 时保留 Agent 与 Session。Worker 释放运行资源。 |
| `model.request_started`、`model.usage`、`model.route_changed`、`model.reserved`、`model.reservation_settled` | 模型、调用和预算。预留/核销共享 reservation correlationId，含 prompt/compaction 类型、预估 Token、实际 Token 或 uncertain 状态。用量给出 input/output/cacheRead/cacheWrite，目录有价格时给出 estimatedCostUsd。目录价格估算与账单分开，额度仍为 unknown。 |
| `tool.started`、`tool.finished`、`operation.reconciliation_required` | 工具名、效果类别、回执 ID、状态。开始/结束可计算时长；未确认动作明确列出回执 ID 并阻塞恢复。 |
| `tool.approval_resolved` | 工具名、回执关联 ID 和本次是否同意。完整参数与系统保存路径保留在临时授权通道。长进程的 `tool.started` 带 managed 标记，直到实际退出才结算原操作。 |
| `verification.finished`、`context.compacted` | 根任务验收记录包含 `executionStatus`、`verdict`、`basis`、`passed` 和 `evidence`。压缩事件记录压缩前后 Token 估计。 |
| `memory.captured`、`memory.recalled` | 数量以及 memoryId、version、kind。文本留在受作用域约束的 Memory Core。 |
| `judgment.evaluated` | 决策点、特征版本、模式、结构化特征、候选集、规则输出、实际选择、可用的 Shadow 结果和关联结算字段。见 [Jev 接入](15-jev-integration.md)。 |
| `visual.draft_ready`、`visual.preview_started`、`visual.preview_finished`、`visual.frames_sent`、`visual.round_finished`、`visual.loop_finished` | 初稿、渲染、帧数、反馈阶段 Token 和编辑状态。按 TaskRun 与 AgentRun 关联。截图和页面内容不进入遥测，独立 Evaluation 结果沿用原任务关联。 |

## 执行和验收指标

- Task 和节点的 `succeeded` 保留为兼容的完成状态。无声明检查时，文本输出、工具成功回执或子节点交付可以证明相应执行事实，最终验收结论为 `unverified`。
- 验收通过以 `verdict === 'verified'` 和 `passed === true` 共同计数。默认 Workflow 通过受约束的工作区文件检查或显式授权的项目命令验证声明目标。文件条件的通过仅代表该条件成立。
- 根任务的 `verification.finished.executionStatus === 'completed'` 表示模型执行到达验收阶段。检查失败时可同时记录执行完成和验收失败。节点结算在有结果时提供 `executionStatus` 和独立的 `verification`。停止、阻塞和恢复核对按 Task 与 Attempt 的状态记录。
- 历史事件仍可按原 Cursor 回放。旧验收无 `verdict` 时，用共享的 `verificationVerdict` 解读。旧版助手文本、成功回执、完成子节点及无法识别的验收证据按未验收计数。根任务和桌面快照自动提供归一后的结论。

消费端应忽略未识别的可选字段和事件类型。所有绝对路径、原始工具输出、Prompt、凭证及 Pi Session 文件留在所属业务或本机存储。中台按任务、节点、Agent Run 和操作 ID 聚合。采集前按自身授权限定访问范围与留存期，观测投影保持只读。

当前预留事件可附带 `estimatedInputTokens`、`maxOutputTokens`、`taskTokenLimit`，核销记录可附带 `durationMs`，用量可与预留共享 `correlationId`。`memory.recalled` 可附带 `elapsedMs`、`contextBytes`、`budgetBytes`，`memory.captured` 可附带 `elapsedMs`。`tool.denied` 记录工具名、效果类别及有限拒绝原因，`tool.approval_resolved` 可附带批准类型，`task.permissions_changed` 可附带此前访问级别。旧历史缺少这些字段时由消费者保留缺测状态。
