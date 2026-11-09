# 首轮执行记录

开发根目录采用现有 Electron UI 所在的工作区。外部材料目录作为设计来源。Host 与 UI 使用独立包，CLI 先覆盖完整执行协议，桌面端可继续通过自己的 Adapter 接入。

| 阶段 | 依赖与实现 | 验收 |
| --- | --- | --- |
| Sprint 0 | 核实 Pi 包及 Durable，冻结运行时 Port，搭建 TypeScript 和 SDK 探针 | 本地可创建 Pi Session、调用受控工具、收事件、停止、重开、换模型。离线替代流不计作在线 Smoke Test |
| Sprint 1 | SQLite / Event Store → Task Engine → Host Command 与 CLI | 重复请求、持久状态与 Session、游标回放、观察者隔离、确定性验收及重启历史 |
| Sprint 2 | Stop/Recovery → Orchestrator / Worker → 能力授权与操作回执 | 停止状态可解释，未确认写入阻塞，Fresh Worker 的完成、失败、预算、释放和恢复 |
| Sprint 3 | 固定模型路由与切换，Memory/Judgment/Sandbox ports，交付说明 | 已授权路由才可启用，保留 Run/Session 关联，记录实际测试与手工 Smoke 步骤 |

首轮单进程只执行一个根任务。每个根任务最多一个只读 Worker。工作区写入限于受控文本工具，验收使用用户指定的文件检查。模型切换和用户指令在安全轮次边界应用。SQLite 不自动重放写入。

## 实际完成与验证

| 阶段 | 实现位置 | 验收记录 | 提交 |
| --- | --- | --- | --- |
| Sprint 0 | `host/src/execution.ts`、`host/src/pi.ts`、Pi 选型 ADR | Pi v1.5.0 初始离线探针 5/5，最终 8/8。Durable 独立探针完成 SQLite 重开、去重、任务图、Abort 与外部标记单次写入验证 | `c2b248f` |
| Sprint 1 | `host/src/store.ts`、`task-engine.ts`、`workspace.ts` | Windows 定向测试 10/10。覆盖状态转移、幂等、游标、事务回滚、进程强杀解锁及工具权限 | `9879b73` |
| Sprint 2 | `host/src/host.ts`、`orchestrator.ts`、`cli.ts` 和恢复测试 | CLI 子进程重开与事件续读。真实 Pi SDK + Faux Provider 委派，Worker 成功、失败、预算拒绝和停止恢复。三项实际强杀覆盖未完成 Stop、写回执丢失、Session 缺失，另测停止超时 | `3da1362` |
| Sprint 3 | `policies.ts`、Pi 环境认证配置、Host 手册与 Durable 可复现探针 | Host 与 UI 类型检查通过。Host 全套 31/31，零失败、零跳过。生产 Provider 请求未执行 | 发布范围收尾提交 |

首次提交 `8062066` 保存了既有 Electron UI 基线。依赖安装第一次连接重置，降低并发并复用缓存后成功。Windows 链接和覆盖重命名用例在 Codex 文件沙箱中受限，最终全量测试在沙箱外执行并通过。

## 本轮接口和职责

- `LocalAgentHost` 处理版本化命令，负责开始、停止、恢复和宿主关闭。进程内 `subscribe` 和 CLI 的 JSONL 接口对消费者提供同一批持久事件。
- `TaskEngine` 维护状态、子节点、Attempt、用户说明、验收及工具回执。`MultiAgentOrchestrator` 管 AgentRun、父子关系与 Session 引用。`PiExecution` 管 Pi Session 生命周期。
- `LocalModelScheduler` 验证路由并管理本地并发预留。额度为 `unknown`。`CodingCapabilities` 在调用边界验证 Root/Worker 权限。`BaselineJudgment` 记录委派规则结果，Jev 留在可替换端口。`NoopMemoryCore` 与 `UnsupportedSandbox` 提供后续接入接口。
- Observability 可通过 `subscribe` 和 `events` 读取，消费者失败与核心写入隔离。流式回复走实时输出，完整对话归 Pi Session 所有。

## 已知边界与后续

- V0 的 DAG 只有根节点和一个无执行依赖的叶子，结构本身限制循环。动态多节点依赖、持久 Agent Team、Jev 在线实验及长期记忆待下一阶段实现。
- 有界停止经过模型中断、工具回执、会话刷盘和资源清理。停止超时与不确定写入进入 `needs_reconciliation`，尚无人工核对结果的登记与解锁命令。SQLite 与 Pi JSONL 之间没有跨存储事务。
- 工具仅处理用户选择目录下的普通文本，无 Shell 和系统沙箱。文本快照、回执和真实文件在断电后的原子性仍需专门验证。
- 首轮生产路径要求显式模型路由与环境凭证。热切换在完整 Pi 轮次之间同 Provider 生效。桌面端仍走 Mock Adapter。下一阶段可优先复用已定稿的 JSONL 契约接通 Electron 主进程，再实现人工核对回执和系统级隔离。
