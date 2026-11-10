# Jev 接入 · 第三轮

Host 在组装时接收 `judgment: { modes, judge, timeoutMs }`。默认各决策点执行本地规则并记事件。Jev 可以实现 [Judge 接口](../host/src/judgment.ts) 的 `evaluate(request, signal)`，返回 `{ output, usage? }`。调用方传入 schema 版本 1、决策 ID、最小化输入、规则结果、允许选择集和证据引用。Judge 的输出必须在允许集内。

| 决策点 | 调用位置 | 规则和可选输出 |
| --- | --- | --- |
| `collaboration.mode` | `MultiAgentOrchestrator.run` 的计划工具 | 根据提案选择 Worker 或 Team。用户或调用方指定的角色锁定。未指定角色而给出 Team Key 时，可在 Worker 和 Team 中选择。 |
| `delegation.worth` | Root 的 `delegate_task` 和 Team 的 `delegate_worker` | 非空、定界目标作为规则入口，输出布尔值。Task Engine 另行校验父节点、深度、节点容量和权限。 |
| `model.task_fit` | `LocalModelScheduler.allocate` | 对通过授权、同 Provider 和能力过滤的候选进行排序。输出候选索引。显式路由的候选只有一项。 |
| `context.relevance` | `ScopedContext.build` | 从当前作用域按词项召回，允许在有限候选内调整首选条目。注入仍受字节预算和作用域约束。 |
| `handoff.sufficiency` | Orchestrator 的子节点交付和验收 | 先取得确定性检查或真实工具回执，再评价交付是否足够。硬证据不足时只有拒绝选项。Task Engine 还校验依赖及子节点结果。 |
| `task.replan` | Root 的 `replan_task_node` | 针对尚未成功、仍有重规划额度、且从未记录写操作的节点，判断是否接受明确的重规划。输出布尔值。 |

- `off` 只运行规则。 `shadow` 保留规则结果并记录合法候选输出。 `active` 可采用合法候选。超时、超载、异常和非法输出均使用规则结果。
- 默认判定限时 1 秒，每个 Kernel 最多四个并发候选判定。适配器须响应 AbortSignal。超时后尚未退出的调用继续占用槽位。
- `judgment.evaluated` 可用来比较规则与候选。按 `id + schemaVersion + mode` 分组，通过 Task 和节点关联到验收、时长、失败率。实验分配和外部模型部署由接入方负责。
- 工具权限、未知副作用、预算、依赖、并发、跨 Provider 数据限制均由 Host 的确定性检查执行。适配器接收最小证据与候选元数据。外部数据传输应遵守所属部署的授权。
