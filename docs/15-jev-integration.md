# Jev 接入

Host 在组装时接收 `judgment: { modes, judge, timeoutMs }`。默认各决策点执行本地规则并记事件。Jev 可以实现 [Judge 接口](../host/src/judgment.ts) 的 `evaluate(request, signal)`，返回 `{ output, usage? }`。调用方传入 schema 版本 1、决策 ID、最小化输入、规则结果、允许选择集和证据引用。Judge 的输出必须在允许集内。

| 决策点 | 调用位置 | 规则和可选输出 | 离线特征与关联事件 |
| --- | --- | --- | --- |
| `collaboration.mode` | `MultiAgentOrchestrator.run` 的计划工具 | 根据提案选择 Worker 或 Team。用户或调用方指定的角色锁定。未指定角色而给出 Team Key 时，可在 Worker 和 Team 中选择。 | 提案数量、节点顺序、Team 候选及依赖标志。用 `resultLink.planRequestId` 查找 `task.plan_changed.correlationId`，用 `features.nodeOrdinal` 查找计划节点。 |
| `delegation.worth` | Root 的 `delegate_task` 和 Team 的 `delegate_worker` | 非空、定界目标作为规则入口，输出布尔值。Task Engine 另行校验父节点、深度、节点容量和权限。 | 角色、目标长度、非空标志。Root 用 `delegationReceiptKey` 匹配回执 ID 摘要。Team 新建节点时用 `planRequestId` 匹配计划事件。 |
| `model.task_fit` | `LocalModelScheduler.allocate` | 对通过授权、同 Provider 和能力过滤的候选进行排序。输出候选索引。显式路由的候选只有一项。 | 是否独立选模、是否显式请求、候选索引及可用的上下文窗口、文本支持、估算成本。用 `agentRunId` 关联 `agent.started`、`model.reserved`。 |
| `context.relevance` | `ScopedContext.build` | 从当前作用域按词项召回，允许在有限候选内调整首选条目。注入仍受字节预算和作用域约束。 | 条目种类、初始名次、证据数、估计字节数。用 `agentRunId` 关联 `memory.recalled`。 |
| `handoff.sufficiency` | Orchestrator 的子节点交付和验收 | 确定性检查或真实工具回执可支持交付。硬证据不足时只有拒绝选项。Task Engine 校验依赖及子节点结果，只有确定性检查可给出通过结论。 | 角色、访问级别、工具证据数、产物数、完成子节点数、是否声明检查以及检查是否通过。用 `taskNodeId` 和 `taskAttemptId` 关联结算事件。 |
| `task.replan` | Root 的 `replan_task_node` | 针对尚未成功、仍有重规划额度、且从未记录写操作的节点，判断是否接受明确的重规划。输出布尔值。 | 节点状态、是否 Root 子节点、重规划次数、是否存在写入回执。用 `planRequestId` 关联 `task.plan_changed` 和后续节点结算。 |

- `off` 只运行规则。 `shadow` 保留规则结果并记录合法候选输出。 `active` 可采用合法候选。超时、超载、异常和非法输出均使用规则结果。
- 默认判定限时 1 秒，每个 Kernel 最多四个并发候选判定。适配器须响应 AbortSignal。超时后尚未退出的调用继续占用槽位。
- `judgment.evaluated` 包含规则输出 `baseline`、实际选择 `output`、允许选择集 `candidates`、影子结果 `shadow`（如有）、结构化 `features` 和 `resultLink`。按 `id + featureSchemaVersion + mode` 分组，通过同一 Task Run 和 Attempt 关联到验收、时长和失败率。缺少对应计划、回执或结算事件时保留结果未知。
- 事件保留白名单中的数值、布尔值和枚举。模型名称、Provider 和证据引用使用 `sha256:<hex>` 关联标识，离线匹配使用同一 UTF-8 字符串摘要。额外的自定义字符串选择只保留候选位置。目标、提示词、文件内容和认证字段留在所属边界。实验分配和外部模型部署由接入方负责。
- 工具权限、未知副作用、预算、依赖、并发、跨 Provider 数据限制均由 Host 的确定性检查执行。适配器接收最小证据与候选元数据。外部数据传输应遵守所属部署的授权。
