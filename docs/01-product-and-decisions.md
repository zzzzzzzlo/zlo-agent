# 01 · 产品目标与已确定决策

## 产品目标

通用、可扩展的**本地优先个人 Agent**，首个 Coding 场景；以 Pi 为底层 Agent Runtime，构建应用层 Task Engine、Multi-Agent Orchestrator、模型资源调度、Memory Core、Judgment Kernel 和独立观测评测中台。用户希望先明确整体架构及数据契约，再逐步实现功能，减少后期高耦合重构。

## 已确定

- **运行形态**：首版仅本地 Windows；GUI 与执行 Host 解耦；将来可迁移数据和远程同步，不在首轮开发云同步。
- **扩展方式**：通用 Agent + Capability Plugin、Agent Profile、Workflow Pack；首个 Profile 为 Coding。
- **Pi 接入**：优先组合官方包，不修改其核心 Agent Loop；兼容性与官方最新 API 需在开工时核验。
- **任务控制**：Task Engine 管动态 DAG、状态、失败重试、验收与持久化；Pi Agent Loop 仅负责单个 Agent 的推理与工具运行。
- **多 Agent**：支持 Root Supervisor + 持久 Team Agent + 临时 Worker 的分层混合模式；Root 负责持续协调但无需空转轮询。临时 Worker 默认不可继续委派；整个 DAG 统一登记。
- **上下文**：Context Builder 只向子任务传必要目标、约束、来源和 Artifact 引用；不默认复制父 Session。持久 Agent 可恢复自己的 Session。
- **Jev**：独立 Judgment Kernel/Decision Registry，可为策略提供可替换判定；rule baseline、shadow/off/active、实验记录；不替代强制权限。
- **模型**：Model Resource Scheduler 独立支持热切换、子 Agent 选模与预算。不同 provider 的 API、授权、订阅额度可用性必须真实区分；未知值保留 unknown。
- **Memory**：独立 Memory Core；保存过去发生的事情并提炼可复用经验，事实和经验分开，追溯来源；初版可以接口/简单存储，自动提炼后续。
- **用户交互**：用户可追加说明或任务、停止整个任务、恢复、热切换模型、查看事件与用量；不需要细粒度 Worker 管理或为每个常规工具调用点按钮。
- **停止含义**：协作式优雅停止（quiesce + checkpoint + resume）。不能对所有运行中外部动作承诺绝对即时停止；挂起或无法确认的副作用应明确标记。
- **中台**：独立 Observatory/Evaluation（检测器）；订阅事件、统计任务结果/工具/模型/Token/记忆，不负责储存长期记忆，也不是 Task 状态权威。
- **沙箱**：保留接口、明确风险；本轮不选择具体实现，未隔离工具绝不可宣称安全。

## 被推迟但需预留

完整 Team Task Board、循环依赖跨模块协调、多 provider 订阅实时额度聚合、Jev 在线模型对照、异步 Memory 提取/整合、SandboxProvider 可用实现、远程 Agent Host、跨设备同步、完整 Dashboard、自动化评测套件。

## 关键架构约束

1. 先锁定接口和不变量，再选择算法和具体后端。
2. 同一工作项的业务状态只有 Task Engine 一个权威源。
3. 异步运行和取消必须在状态存储中可解释、可恢复。
4. Agent 可“建议”，不能跳过程序的授权、预算和状态转换。
5. 真实安全边界不由 Prompt 提供。
6. 故障时优先正确、保守、可恢复；不以虚假的“任务成功”换取体验。
