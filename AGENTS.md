# 开发约束（供 Codex / 其他 Coding Agent 执行）

1. 在动手前阅读 `CODEX_START.md`、`docs/01-product-and-decisions.md`、`docs/02-architecture.md` 和 `docs/08-implementation-plan.md`。先调查仓库现状，增量开发；不得随意覆盖既有代码、文档或未提交修改。
2. **不自行改写 Pi Agent Loop**；通过官方 SDK / 公开扩展接口接入。使用 `https://github.com/earendil-works/pi` 当前官方上游核实包名和 API，不能仅凭旧版教程推断。
3. 保持模块化单体、依赖倒置、接口清晰；模块间禁止直接写入对方数据库或导入对方内部实现。数据存储层可以共享 SQLite 实例，但表所有权/仓储接口必须独立。
4. 唯一权威：Task Engine 负责 Task 状态；Agent Runtime 管理 Pi Session；Memory Core 管理长期记忆；Resource Scheduler 管理额度/资源；Observability 只订阅和分析。
5. 用户按“停止”后采取**停止接收新工作 → 取消/收敛活动工作 → 持久化一致性检查点 → STOPPED**，并支持恢复。不能保证任意外部副作用恰好执行一次；未知结果应标记 `needs_reconciliation`，不得盲目重试。
6. UI 不要求用户逐次审批已经通过系统策略的普通操作；对于策略未授权的高风险动作，默认拒绝/阻塞，不得默默绕过，也不得虚称安全沙箱已完成。
7. Jev 等模型仅可帮助语义判断，绝不授权越权操作；每个 Decision Point 保留 rule baseline、shadow/active/off 和可观测事件。
8. 主 Agent 可提出拆解和委派，程序执行任务依赖校验、深度/并发/预算约束、资源选择和验收。两个 Agent 不可在同一未隔离的写入范围无约束并行。
9. 每一步应有可执行测试和验收输出；没有真实 API 凭证时使用测试替身，同时提供可在真实 Pi SDK 上运行的手动 Smoke Test 说明。
10. 适时阅读成熟的 Claude Code 官方文档、Codex 开源仓库、DSH 开源仓库。重点学架构和已公开 API；不依赖/复制 Claude Code 泄露源码，也不冒认其开源许可证。
11. 不要在首轮为了未来扩展提前实现大型微服务、云平台、真实订阅逆向或多个数据库；实现最短可运行闭环。
12. 做完阶段性工作必须报告：完成内容、实际运行的测试、尚未实现与风险、下一步；尽可能保留独立可回滚的 Git Commit。
