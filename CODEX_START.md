# 给 Codex 的首轮开发任务（可整段复制）

你现在担任这个项目的 **Lead Engineer / Architecture Implementer**。我们要开发一个 Local-first 通用 Agent，第一场景是 Windows Coding Agent。用户已经完成大部分架构决策；你的职责是**遵守架构、参考成熟上游、执行首轮开发并拿出可运行结果**，不是重新发明需求或一次性造出全部平台。

## 0. 首先行动

1. 阅读当前仓库并检查是否已有未提交修改。不要覆盖、清理或重写用户数据。
2. 阅读本目录 `README.md`、`AGENTS.md` 和 `docs/01` 至 `docs/09`（特别是 `docs/02`、`docs/03`、`docs/04` 和 `docs/08`）。
3. 在当前仓库中写一份简短的 `docs/adr/0001-pi-runtime-selection.md`，之后开始编码。除非存在真正无法继续的外部阻塞，不要仅输出计划就停止。
4. 遇到没有确定答案的实现问题，优先查当前官方 Pi、Codex、DSH 和 Claude Code 官方文档或开源实现，并将采用/不采用的理由写进 ADR。不得把 Claude Code 泄露源码当成开源依赖。

## 1. 架构不可变约束

- **单个 Agent 的推理与工具调用由 Pi 原生 Runtime 完成**。不要 Fork 或重写 Pi Loop。
- `TaskEngine` 是任务状态、依赖与验收的唯一权威；`Orchestrator` 负责 Agent 树与生命周期；`AgentExecutionAdapter` 负责 Pi Session；`ModelResourceScheduler` 管 ModelRoute/预算；Memory 与 Judgment 仅通过接口接入；Observability 独立只读订阅事件。
- 模块之间不许直接操作彼此的业务数据库，不许循环依赖；通过 ports/adapters 和版本化 DTO 通信。第一版本地模块化单体，避免微服务。
- Root Agent 可以通过工具提交委派和计划建议，但不能直接绕过 DAG 校验、权限、预算或验收规则。
- 用户可追加说明/任务、停止根任务、恢复、手动选择模型；无需每个 Worker 的 GUI 管理或逐条普通工具审批。
- 用户停止 = 接受 Stop Intent → 阻止新工作 → 安全收敛/中断当前工作 → 持久化一致性检查点 → STOPPED。明确允许存在有限等待或失败状态；绝不能在未保存状态时虚报停止完成。
- 未确认外部副作用不自动重放；具幂等性质的重试必须有 receipt/idempotency key 和恢复检查。
- 不伪造沙箱安全。SandboxProvider 接口可以是 unsupported；有风险的命令/写入在缺少安全保证时拒绝或按明确保守策略限制。
- 模型订阅/API 接入必须经官方支持的渠道，不做逆向登录、非官方额度聚合或账号轮换。

## 2. Pi 选型必须先做兼容性 Spike

先以 **当前** `https://github.com/earendil-works/pi` 为权威核实：

- 常规 SDK：`@earendil-works/pi-coding-agent` 的 Session、事件订阅、持久化、取消、模型切换与工具注册。
- 实验性 `@earendil-works/pi-durable` 的 Task Graph、Abort、Resume、Storage 和运行时能力，评估它能否满足当前第一阶段 Coding Agent 特性；其 API 明确标记为 Experimental。
- 不要假设这两个包能无缝互换，也不要同时创建两套不同的 Task 状态权威。

给出决策与证据，若采用稳定 SDK，则建自有 TaskStore/TaskEngine；若采用 Durable，则基于官方持久任务能力封装业务 DAG、验收和协作，使用版本锁定与可替换适配层。

## 3. 本轮需要做出的实际成果

按 `docs/08-implementation-plan.md` **分阶段完成**，优先实现一条可信纵向链路：

- 本地 Host + Command/Event 协议；Task 创建和状态持久化。
- Pi AgentExecutionAdapter，允许真实 Pi 手动 Smoke Test；无在线凭证时可以 Fake Backend 运行离线集成测试。
- 独立 Session/Task/AgentRun 身份与事件关联；事件流可订阅、可按 cursor 恢复。
- `addInstruction`、`addTask`（允许第一版仅增加简单子任务）、`stop`、`resume`、`requestModelSwitch` 的接口；后两项不能假完成。
- 优雅 Stop 和恢复；区分活动 Tool 的确认结果与未知副作用；重启不忘记 Stop Intent。
- 一个 `delegate_task` 路径：Root 通过受控工具创建单个临时 Worker；子 Agent Fresh Context + 结构化结果；受限深度与预算。
- 验收模块至少支持一个确定性检查（如测试进程成功、产物检查），不允许仅由 Agent 宣称成功。
- MemoryCore、JudgmentKernel、ModelResourceScheduler、SandboxProvider 等未来模块遵循 `docs/06/07` 的**最小可替换接口**；首轮不做大型具体实现。用户手动模型切换若 Pi 当前支持，则提供真实路径；否则明确未支持并保留契约。
- 一个可以查看任务状态、流式消息、Stop/Resume 的最小交互入口（优先本地 CLI；如已有 UI 代码则复用；有余力再加简洁 localhost UI），保持 GUI/Host 解耦。

**不要**因为首轮目标庞大而只输出文档；应先实现 Sprint 0 + Sprint 1 的可运行闭环，再继续 Sprint 2。若遇到时间或环境限制，交付当时能运行的部分、测试结果和已知阻塞；不虚报完成。

## 4. 测试、审查与验收

离线测试必须覆盖：状态机；持久化与幂等；Stop→STOPPED→Resume；重复 Stop；重启时未完成 Stop 的延续；Tool 副作用未知时不得盲目重试；事件顺序/重复与断线续读；Task/Agent/Session ID 的一致性；Worker 深度及预算限制；必要测试不通过时任务不能 Succeeded；Observability 消费者故障不能阻塞 Host。

尽可能用 Git Commit 保存各阶段，执行项目现有 lint/typecheck/test。新增 API 要有文档和至少一个契约测试。真实模型 Smoke Test 必须**仅在用户环境确有可用授权时**运行，不能擅自创建付费资源，不能硬编码 Key。

## 5. 结束时请按如下格式汇报

1. **本轮实际完成的功能**（区分已实现与仅预留接口）。
2. **Pi SDK / Durable 的选型与证据**（使用版本和 ADR）。
3. **目录结构与关键接口**。
4. **真实执行的命令与测试结果**（通过/失败/跳过）。
5. **Stop/Resume 与委派的复现步骤**。
6. **安全及可恢复性限制**（尤其非幂等工具）。
7. **下一次开发建议**（完整 Agent Team、Jev、Memory、Model Scheduler 等）。

现在开始：先检查仓库和上游 API，制定一个简短可执行计划，然后尽可能直接落地代码、运行测试，完成后汇报。不要只生成一份新的规划文档。
