# 08 · 首轮开发计划与验收

## 原则

第一轮交付**运行可证明的纵向闭环**，不是所有未来功能的空接口大集合。共享 Domain Contracts 可以先精简后增长；除了恢复与安全关键结构，避免提前创造冗余层。每步包含断言、演示与变更记录。

## Sprint 0：环境与底座验证（务必先做）

1. 检查当前仓库、现有 package manager、Node/TS 版本与 Windows 兼容性，不覆盖用户原有改动。
2. 阅读 Pi 当前官方 SDK (`@earendil-works/pi-coding-agent`)；创建 `PiAgentExecutionAdapter` 的最小原型，验证创建 Session、订阅事件、工具调用、取消、恢复、手动切换模型（若 SDK 支持）以及 session 存储。
3. 单独验证实验性 `@earendil-works/pi-durable` 与上述核心需求能否兼容。写一页 ADR：可复用能力、Breaking Risk、迁移代价、选型结论；**不要把两个 SDK 的内部状态同时维护为权威源**。
4. 初步建 workspace / TS 类型检查 / Vitest（或项目现有测试框架），通过离线测试。

**DoD**：SDK 探针编译通过；可运行一个无外部模型要求的假模型/Adapter 测试；若本地有有效凭证，真实 Pi Smoke Test 能创建 Session 并接收 events； ADR 有证据和约束。

## Sprint 1：Host / Task / Event 最小闭环

1. 建立 `LocalAgentHost` 与独立 `Command API`；可先 CLI + SSE/订阅接口，无需美观 GUI。
2. SQLite TaskStore：Task / Attempt / Stop Intent；EventStore/Outbox：事件序列与 cursor，持久化契约。
3. TaskEngine：单节点任务提交、状态转换、验收结果、可重试 Attempt、幂等 `requestId`。
4. AgentExecution 适配 Pi；接收流式事件，建立 Task/AgentRun/Session 关联；适配工具执行前后事件。
5. 实现 `createTask / getTask / subscribe / addInstruction / stop / resume` API；UI 若做，只做一页任务表、事件流、停止/恢复和模型路由状态。

**DoD**：从 Task 提交到真实或模拟 Agent 完成、验证、持久化事件的完整链路；UI/CLI 可观察；重启后任务历史不丢。

## Sprint 2：可恢复的停止与子任务委派

1. `StopController`：持久化停止意图、阻止新分派、下发 quiesce、等待/中断、Flush、完成 Stop。
2. `RecoveryCoordinator`：重启扫描未完成任务，按回执 reconcile；对未知副作用不自动重放。
3. 增加一次 `delegate_task` 协作工具，创建 **一个**临时 Worker（深度硬限制）；TaskEngine 校验任务范围、依赖、预算与状态；Orchestrator 运行 Worker。
4. `ContextBuilder`：生成 Fresh Context Package（目标、约束、相关文件引用、输出格式）；结构化交付摘要与证据引用。
5. `Verifier`：至少一个确定性检查器（如测试运行状态或文件/Artifact）；通过后才标记 TaskNode succeeded。

**DoD**：具备 1 Root + 1 Worker；根任务在 Worker 活跃时 Stop 后可恢复；崩溃恢复一致；没有第二套任务状态。

## Sprint 3：预留可替换能力与开发体验

1. Model Scheduler：先完成最基本的可用 Route、模型要求、用户手动切换/不可用错误与 Usage 记录；不做三家订阅余额逆向。
2. Judgment：`DecisionSpec` + `Noop/Baseline/Shadow` 插口；先选 `delegation.worth` 做规则基线及事件，不接 Jev 在线服务。
3. Memory：`MemoryCore` 最小 Port 与 Noop 实现，备好来源引用；不做复杂长期记忆抽取。
4. Plugin/Profile：可配置 Coding Profile 与工具集合，不需要完备插件生态；Sandbox 接口仅保留并显式标识未启用。
5. README：开发、配置、演示、数据目录与恢复测试指令；补充系统约束的 ADR。

**DoD**：模块接口可替换，测试不需要真实 API Key；至少一条真实 Pi SDK 手工验证路径；Stop/Resume 与工具隔离限制有明确实际能力说明。

## 自动化测试清单

- 状态转移非法输入被拒绝；DAG 无环、依赖检查、任务版本冲突。
- 重复提交相同 `requestId` 无重复任务/副作用。
- Worker 完成报告不等于验收成功；Verifying 与 Succeeded 分开。
- 取消/Stop 在模型运行和工具结果写入期间都能保持一致可解释状态。
- 杀进程后重启：活动任务恢复为可安全继续或明确的 `needs_reconciliation`。
- Stop 未处理完就崩溃：再次启动依然优先完成 Stop。
- 委派预算/深度限制不可绕过；重叠写入在无沙箱时被禁止或串行化。
- Event cursor 断线续订、事件去重；观测消费者异常不影响 Agent 执行。
- 失败 Provider 不会默默换成未授权 Route；未知 quota 保持 unknown。

## 首轮汇报格式

提供：架构选择 ADR、实际代码文件路径、运行命令、通过/跳过的测试、一次可运行任务与一次 Stop/Resume 演示、当前限制、下一阶段建议。不能声称未执行的测试通过。
