# 06 · Memory / Judgment / Model Scheduler 的最小边界

## Memory Core

长期记忆服务独立于 Session、Task 和 Observability。Memory Core 从已验收证据提取事实和经验，记录引用及版本，按作用域持久化和词项召回。原始执行历史由所属模块保管。

建议未来的生命周期：Session/Task 证据 → 候选事实/经验 → 去重与冲突整合 → 版本化长期记忆 → 根据 Task Scope 检索/注入 → 使用效果反馈。借鉴 Codex 的两阶段异步管线、Claude 的简短索引+按需读取、Hy-Memory 的 Facts/Experiences 与代码 Diff 链。记忆与执行 Trace 不属于同一业务表。

## Judgment Kernel：先把评价机制建好

每个点定义 `DecisionSpec<Input, Output>`，至少有 `id`、`schemaVersion`、候选策略、mode、结果追踪。结果包括输入证据引用、baseline 结果、判定耗时与 Token/费用（若有）。

推荐预留判定点：

| ID | 所属模块 | 基线 | Jev 候选作用 |
|---|---|---|---|
| `collaboration.mode` | Orchestrator | 任务规模、依赖与用户策略规则 | 推荐独立 Worker / Team / 混合 |
| `delegation.worth` | Orchestrator | 额外成本与计划粒度阈值 | 值不值得新开 Worker |
| `model.task_fit` | Model Scheduler | 显式能力过滤+经验统计排序 | 在合法候选中判断任务适配度 |
| `context.relevance` | Context Builder | FTS/引用优先、可选向量 | 相关性排序 |
| `handoff.sufficiency` | Task verification | 结构化字段+必需证据 | 交付是否足以推进后续工作 |
| `task.replan` | Task Engine/Orchestrator | 固定重试/失败升级规则 | 选择重试或重新规划 |

**明确不使用 Jev 授权的事项**：沙箱越权、文件路径 ACL、额度是否足够、委派深度、并发上限、DAG 无环校验、工具合法性、危险副作用。Jev 可以额外提示风险，不能使不允许的操作变为允许。

默认 `off` 执行规则并记录结果，`shadow` 额外记录候选，`active` 可采用合法候选。Jev 可通过已实现的可替换 Judge 接入，见 [接入说明](15-jev-integration.md)。

## Model Resource Scheduler

外部接口：`discoverModels()`、`allocate()`、`reconcile()`、`requestSwitch()`、`getRouteStatus()`。独立管理实时资源信息，不能要求 Observability 先在线。

流程：
1. **硬过滤**：授权、已配置的 Provider Route、功能兼容性（工具调用/上下文等）、用户指定模型、数据传输规则、保守预算。
2. **排序**：用户偏好、能力画像、延迟、实际/估算成本、缓存影响、provider 可用性。
3. **可选 Jev**：在可信的候选列表里语义重排，不创造不可用的 Route。
4. **预留与核销**：reservation ID、request ID 与真实 Usage 关联；遇到进程崩溃可核对。

一个具体 `ModelRoute` = Provider + Model + **授权/调用通道**，不是只有模型名。订阅配额可能无法实时获取；额度字段至少区分 `provider_reported / estimated / unknown`，不可把 API Token 用量推断成订阅剩余额度。

热切换只在安全的模型请求边界，保留现有 Task/Agent/Session 身份；上下文迁移检查兼容性和跨 Provider 数据权限。首轮至少实现使用 Pi 的一种已有模型 Route，并保留显式手动切换命令/测试替身。拒绝不受官方支持的订阅接口逆向或绕过授权。

## 将来中台反哺模型路由

Observability/Evaluation 可离线输出带版本的 `ModelPerformanceProfile`：按任务类型的成功率、耗时、成本、工具失败率、样本数及时间窗。Scheduler 消费快照，但不得成为中台数据库的强依赖。不能仅因某一次运行好就立即改变全局模型画像。
