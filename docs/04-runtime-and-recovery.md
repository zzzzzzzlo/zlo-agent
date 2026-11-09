# 04 · 运行控制、优雅停止与故障恢复

## 首轮实现路径

用户下达任务 → Host 记录 Task → 创建 Main Pi Session → 主 Agent 执行 → 可通过工具提出子任务 → TaskEngine 校验依赖/范围 → Orchestrator 启动受控 Worker → 回传结构化产物与证据 → Verifier 检查 → TaskEngine 提交结果 → 事件供 UI 和监控读取。

## 用户行为

- `add_instruction`：向当前根任务新增约束/补充说明；到模型请求边界安全注入，不直接修改运行中的 Tool 参数。
- `add_task`：申请向根任务添加新目标/子任务；必须生成可审查的任务变化，遵循 DAG 及预算。
- `request_stop`：用户按一次后立即确认“已接收停止请求”，**不等同于已停止**；状态展示为 `stopping`，直到一致性检查点完成。
- `resume_task`：恢复保存的任务关系与 Session，先核对被中断动作，再推进尚未完成的节点。
- `switch_model`：记录偏好，经过 ResourceScheduler 校验，通常在下一个模型调用边界生效；不能把流式生成中间的 Token 从模型 A 直接切给模型 B。

## 优雅停止：两阶段协议

**Phase A — Quiesce**
1. 持久化 `stop_requested`（命令幂等），禁止新的子任务激活和新外部副作用。
2. 向所有活跃 Agent 广播停止意图；等待当前可安全结束的步骤，限制等待上限。
3. 正在进行的 LLM 请求可在请求/轮次边界停止；超时可执行 abort，但保留 `interrupted` 记录。

**Phase B — Checkpoint / Settle**
4. 工具动作逐个记录最终确定的 `succeeded/failed` 回执；未知结果标记 `unknown_effect`，需恢复时核对，不得自动重复执行。
5. 保存 Pi Session/Agent 映射、未完成 TaskAttempt、DAG 版本、未送达命令和资源预留记录；必要时等待持久化 `flush`。
6. 释放 Worker/模型配额资源，持久化 `stopped`，发布 `task.stopped`。如果持久化失败，不能声称已经安全停止；报告 `needs_reconciliation`。

**注意**：对正在进行的 OS 进程/网络操作，没有通用方案能确保“任意瞬间停止且副作用绝不发生”。首轮仅承诺有界停止、状态完整、未知副作用显式标记、恢复时保守核对。高风险操作若缺少执行回执和幂等凭证，不自动重试。

## 崩溃与启动恢复

1. Host 启动时独占本地 TaskStore 写者；扫描所有 `running/stopping/stop_requested` 等非终态根任务。
2. 检查 Pi Session 存储健康、Event Store 连续性、工具回执与现存文件/进程状态。
3. 对无法证明成功或失败的操作标记 `needs_reconciliation`；不要自动重放未知副作用（尤其写数据库、部署、支付等）。
4. 可重放的只读操作或带幂等键且确认协议的操作允许自动重试；每个 Attempt 有独立 ID 和限定重试次数。
5. 恢复时先完成待处理的停止意图，不能因为重启忘记用户按过 Stop。
6. 如果模型 Provider 不可用，保留任务并进入 `blocked` 或等待用户换模型；不抹掉失败证据。
7. 对重复的 `requestId` 返回已有命令结果，避免用户/UI 重发导致重复任务。

## 参考成熟项目的处理经验

- **DSH**：append-only Session Events；明确 `flush()` 是耐久边界；崩溃时修复未闭合 Turn 而不是丢弃整个 Session；单 Session 单写者。
- **Codex**：Session 的恢复、子 Agent 管理和工具执行应有明确生命周期与权限边界；具体以当前官方源码核验。
- **Claude Code**：Resume Session、Stop/PostToolUse 等 Hook 可用于恢复与确定性检查，但 Hook 不是持久任务引擎的替代。
- **Pi**：优先使用已存在的 Session Manager；重点评估官方 `pi-durable` 是否可降低恢复系统复杂度。`pi-durable` 文档含 `Harness.resume()`、`root.abort()`、TaskGraph、工具 replay policy，但仍为实验 API，需锁版本并做适配测试。

## 测试场景（必须有可自动复现实验）

- 停止前无子任务：收到 Stop → 持久化 → `stopped` → Resume → 可继续。
- 两个 Worker 活跃时 Stop：不再创建新 Worker；依照执行完成/中断语义收敛；确保父任务与子任务状态一致。
- Stop 命令重复送达：幂等。
- 在“工具调用完成、回执写库之前”故意崩溃：标记未知，不重复执行非幂等动作。
- Host 重启时仍有 `stop_requested`：必须先完成 Stop，不能自行重启工作。
- Pi Session 压缩或切换：任务状态与 Event Seq 不丢。
- Provider 配额不足：任务保持可恢复、模型路由能报告真实原因。
