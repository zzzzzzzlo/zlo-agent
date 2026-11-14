# Jev 接入

在桌面「模型与账号 → 判定模型 (Jev)」选择供应商。TypeSafe 预填 `jev-latest`，OpenCode 预填限时免费的 `jev-1.13-free`。也可以选择「自定义 System One」填写兼容服务的完整请求地址和模型 ID。推荐使用 HTTPS，本机服务可使用 HTTP 回环地址。保存设置后，复制对应地址的 Key，点击「添加 API Key」并在系统弹窗中确认。Electron Main 按完整地址加密保存各自的密钥，Renderer 仅接收凭证状态。点击「测试连接」会发送合成样例，可在全局关闭时验证。 [TypeSafe 模型目录](https://docs.typesafe.ai/api/list-models) · [OpenCode 模型目录](https://opencode.ai/docs/console/models#jev)

运行设置默认全关。全局启用或在启用时切换请求地址，需要确认外发范围。新启用的点使用 Shadow，可切换 Active。点击「保存 Jev 设置」后生效，切换路由或删除密钥会取消旧配置下进行中的判定。设置及最近状态保存在 Host SQLite，密钥位于独立的系统加密文件。请求拒绝重定向。

Host 复用 [Judge 接口](../host/src/judgment.ts)。调用方传入 schema 版本 1、决策 ID、决策输入、规则结果、允许选择集和证据引用。[Jev Adapter](../host/src/jev-judge.ts) 以白名单提取输入，由 System One 返回带概率的 `noul` 结果。二选一的布尔判定采用 ≥0.80 和 ≤0.20 的边界。候选题按 [MU 的 Judge 设计](https://usemu.dev/en/docs/judges/) 使用同一份状态批量提交，胜出候选须达到 0.80 且领先次名至少 0.15。

| 决策点 | 调用位置 | 规则和可选输出 | 离线特征与关联事件 |
| --- | --- | --- | --- |
| `collaboration.mode` | `MultiAgentOrchestrator.run` 的计划工具 | 根据提案选择 Worker 或 Team。用户或调用方指定的角色锁定。未指定角色而给出 Team Key 时，可在 Worker 和 Team 中选择。 | 提案数量、节点顺序、Team 候选及依赖标志。用 `resultLink.planRequestId` 查找 `task.plan_changed.correlationId`，用 `features.nodeOrdinal` 查找计划节点。 |
| `delegation.worth` | Root 的 `delegate_task` 和 Team 的 `delegate_worker` | 非空、定界目标作为规则入口，输出布尔值。Task Engine 另行校验父节点、深度、节点容量和权限。 | 角色、目标长度、非空标志。Root 用 `delegationReceiptKey` 匹配回执 ID 摘要。Team 新建节点时用 `planRequestId` 匹配计划事件。 |
| `model.task_fit` | `LocalModelScheduler.allocate` | 对通过授权、同 Provider 和能力过滤的候选进行排序。输出候选索引。显式路由的候选只有一项。 | 是否独立选模、是否显式请求、候选索引及可用的上下文窗口、文本支持、估算成本。用 `agentRunId` 关联 `agent.started`、`model.reserved`。 |
| `context.relevance` | `ScopedContext.build` | 从当前作用域按词项召回，允许在有限候选内调整首选条目。注入仍受字节预算和作用域约束。 | 条目种类、初始名次、证据数、估计字节数。用 `agentRunId` 关联 `memory.recalled`。 |
| `handoff.sufficiency` | Orchestrator 的子节点交付和验收 | 确定性检查或真实工具回执可支持交付。硬证据不足时只有拒绝选项。Task Engine 校验依赖及子节点结果，只有确定性检查可给出通过结论。 | 角色、访问级别、工具证据数、产物数、完成子节点数、是否声明检查以及检查是否通过。用 `taskNodeId` 和 `taskAttemptId` 关联结算事件。 |
| `task.replan` | Root 的 `replan_task_node` | 针对尚未成功、仍有重规划额度、且从未记录写操作的节点，判断是否接受明确的重规划。输出布尔值。 | 节点状态、是否 Root 子节点、重规划次数、是否存在写入回执。用 `planRequestId` 关联 `task.plan_changed` 和后续节点结算。 |

- `off` 只运行规则。 `shadow` 保留规则结果并记录合法候选输出。 `active` 可采用合法候选。超时、超载、异常和非法输出均使用规则结果。
- 每次 Jev 判定限时 3.5 秒，最多四个并发判定和一个连接测试。每任务最多 32 次请求，跨重启累计。Host 每分钟最多发起 60 次请求（含测试），429 后暂停 15 秒。请求体限制为 12 KiB，响应为 32 KiB。只有一个合法候选时直接使用规则。
- Jev 可以收到经过裁剪和脱敏的任务或节点目标、交付摘要、成功工具类别和检查结果，以及已获准召回的记忆片段或模型元数据。请求不附会话历史、完整 Prompt、文件内容、工具输出、证据路径字段或认证信息。启用前确认任务内容允许发往 TypeSafe，任务文字中自行嵌入的敏感信息仍可能超出自动脱敏的识别范围。
- `judgment.evaluated` 包含 `baseline`、实际选择 `output`、合法候选 `candidates`、`judgeOutput`、`disagreement`、`judgeModel`、`fallbackReason`、`requestSent`、`usage` 和 `resultLink`。`shadow` 保留给已有消费者。没有关联的结算事件时，评估结果保持未知。外发片段不写入事件。候选执行模型和证据引用以摘要记录，Jev 返回的版本 ID 单独记录。
- Observatory 通过 TaskRun、Attempt、AgentRun 和关联回执展示判定。TypeSafe 费用按 [公示单价](https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost) 估算，OpenCode 免费 Jev 估算为零，其它自定义定价保留未知。费用与执行模型和 Evaluation 分开计量。
- 工具权限、未知副作用、预算、依赖和执行结果由 Host 的确定性检查约束。Shadow 的建议不会改变执行。Active 可调整合规计划、拒绝委派或交付等，在硬约束不满足时只有规则允许的候选。
- Windows 桌面端启动时为 OpenCode 官方判定地址读取系统 HTTP/HTTPS 代理。这个代理仅供 OpenCode System One 请求使用。

## 真实 API 冒烟

准备已有余额的 TypeSafe API Key。在桌面保存密钥后点击「测试连接」，核对状态和实际版本。打开 Shadow 并运行包含 Team 候选、委派、同 Provider 多模型、相关记忆、交付证据及可重规划节点的任务。打开对应 TaskRun 的 Judgment 决策表，核对规则、实际选择、Jev 建议、回退原因和用量。关闭全局后再次运行同类任务，确认只生成规则记录。自动化测试用模拟的 System One 响应验证协议与执行链。
