# 中台数据契约 · 第三轮

使用 Host JSONL 的 `listTasks` 发现任务，并用 `events(taskId, after)` 回放或 `subscribe(taskId, after)` 续订。同一 Task 的 `seq` 单调增长，从客户端最后持久化的 Cursor 续读，按 `id` 去重。Task 间无全局序号。桌面使用独立的 Conversation 事件流和 Cursor。消息增量与完整对话只供有权限的桌面会话使用。

## 公共信封

`schemaVersion` 当前为 1。每条事件包含 `id`、`seq`、`occurredAt`、`taskId`、`type`、`payload`。按事件来源附带 `taskRunId`、`taskNodeId`、`taskAttemptId`、`agentId`、`agentRunId`、`parentAgentRunId`、`sessionId`、`correlationId` 和 `causationId`。字段缺省时由消费者保留未知值。业务事件入库后再通知订阅方，订阅方故障隔离。

| 事件 | 数据与投影 |
| --- | --- |
| `task.created`、`task.state_changed`、`task.stop_requested`、`task.stopped`、`task.resumed` | 状态、原因、时间。按 Run/Attempt 计算完成、停止、阻塞率和时长。 |
| `task.plan_changed`、`task.node_started`、`task.node_settled`、`task.worker_settled` | 计划版本、节点、父节点、角色和依赖标识。结算事件携带状态及可用的验收和证据引用。用 `getTask` 获取权威 DAG 快照。 |
| `agent.started`、`agent.finished` | 角色、开始路由、父 Agent、Run/Session、完成状态、生命周期和证据计数。Team 进入 idle 时保留 Agent 与 Session。Worker 释放运行资源。 |
| `model.request_started`、`model.usage`、`model.route_changed`、`model.reserved`、`model.reservation_settled` | 模型、调用和预算。预留/核销共享 reservation correlationId，含 prompt/compaction 类型、预估 Token、实际 Token 或 uncertain 状态。用量给出 input/output/cacheRead/cacheWrite，目录有价格时给出 estimatedCostUsd。目录价格估算与账单分开，额度仍为 unknown。 |
| `tool.started`、`tool.finished`、`operation.reconciliation_required` | 工具名、效果类别、回执 ID、状态。开始/结束可计算时长；未确认动作明确列出回执 ID 并阻塞恢复。 |
| `verification.finished`、`context.compacted` | 确定性验收通过与证据代码，或压缩前后 Token 估计。 |
| `memory.captured`、`memory.recalled` | 数量以及 memoryId、version、kind。文本留在受作用域约束的 Memory Core。 |
| `judgment.evaluated` | 决策 ID、版本、mode、规则/选用结果、可用的 Shadow 候选、状态、证据引用、时长和可用的 Judge 用量。见 [Jev 接入](15-jev-integration.md)。 |

消费端应忽略未识别的可选字段和事件类型。所有绝对路径、原始工具输出、Prompt、凭证及 Pi Session 文件留在所属业务或本机存储。中台按任务、节点、Agent Run 和操作 ID 聚合。采集前按自身授权限定访问范围与留存期，观测投影保持只读。
