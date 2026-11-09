# 07 · 权限、安全边界与观测事件

## Capability / Permission 原则

- Profile 的工具列表只用于**告诉模型有哪些能力**，不构成授权。
- 实际工具执行前，由可信 `CapabilityGateway` 依据用户授权、Agent Identity、Task Scope、写入路径、敏感数据和当前策略进行强制检查。
- 子 Agent 有效权限必须是用户/Host 授权、父 Agent Scope、子任务 Scope 和运行隔离策略的交集；不能通过工具参数自我升级。
- Context Builder 也必须应用相同的数据访问与跨 Provider 发送限制。获取 Context 不得绕过 Tool Gate。
- 高风险操作（真实付款、部署、删除重要数据、提权等）首轮默认拒绝/显式禁止，若将来需要授权，应提供明确的用户授权流程；用户不想逐条干预普通安全操作并不意味着默认全权执行。
- 跨 Agent 写入：同工作树中没有真实隔离时，不可允许两个写 Worker 竞争相同文件范围；可串行化直到 Worktree 隔离实现。
- `SandboxProvider` 首轮允许只有 `UnsupportedSandbox` 返回错误；不可用的沙箱不能 silently fallback 为不受限执行。

## Observability 不是 Task/Memory 权威存储

- Event Bus 是统一的事件订阅入口；Agent Runtime、Task Engine、Scheduler、Memory Core、Judgment Kernel 发布带 correlation ID 的领域事件。
- `Observability` 只读事件，建立投影、指标、图表；不能经观测系统回写核心业务表。
- 关键状态事件与业务状态在同一事务或可恢复的 Outbox 内写入；流式文字可以做背压和采样，断连后通过 cursor 或快照恢复。
- 每条事件带 `schemaVersion`、`taskId`、`eventId`、`seq`、时间戳、agentRunId（如有）。
- Token 与成本必须区分真实 Provider Usage 和估算；模型资源调度器自己维护实时 reservation，观测模块后续核算。

## 首轮观测事件集合

`task.created`, `task.state_changed`, `task.stop_requested`, `task.stopped`, `task.resumed`, `task.plan_changed`, `agent.started`, `agent.finished`, `model.request_started`, `model.usage`, `tool.started`, `tool.finished`, `verification.finished`, `model.route_changed`, `operation.reconciliation_required`。

仅保留接口（不必真调用）: `memory.recalled / memory.captured / judgment.evaluated / sandbox.denied`。

## 指标与数据脱敏

- 可累计：每 Task 的运行时长、实际模型调用次数、input/output/cache Token、工具调用数量/耗时/成功率、Agent 委派深度、子任务成功率。
- 首轮不实现高级 Quality Score；只记录来自明确验收器的 pass/fail、证据引用。
- 不记录 API Key、OAuth Token、完整环境变量等密钥；默认避免记录完整个人文件内容及完整模型输入。需要调试时采用明确权限和短期保留。
- 日志、模型交互和工具返回均属于不可信内容，不能据此修改安全策略。
- 停止/恢复必须有一致可重播的事件顺序，不以 SSE 消息顺序替代存储事务顺序。
