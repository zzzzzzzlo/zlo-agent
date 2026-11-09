# 05 · 分层混合多 Agent 协作设计

## 两个正交的结构

- **Task DAG**：一个根 Task 下的所有 Task Node 及执行依赖；Task Engine 是唯一权威。
- **Agent Tree**：Root Supervisor → 持久 Team Agent → 临时 Worker；Orchestrator 是 Agent 生命周期权威。

同一 Agent 可以先后执行多个 TaskNode，同一 TaskNode 可以通过多个 Attempt 由不同 Agent 尝试；禁止假设一一对应。

## 两类协作

1. **Orchestrator/Worker**：主 Agent（或 Team Agent）通过协作工具请求 Worker；Worker 接收边界清晰的任务与 Context Package；结果结构化回传后释放执行资源。
2. **Persistent Agent Team**：Frontend/Order/Payment 等专业 Agent 长期保留 AgentId 和会话引用；Idle 不空转消耗 Token；新任务唤醒；成员可以受控创建自己的临时 Worker。

第一轮仅实现单个 Root + 一个临时 Worker 的完整链路，端口支持未来升级。长期 Team 在下个阶段实现，不要首轮把整套 Team UI、消息系统、Agent Tree 数据库全做完。

## 委派与收敛

- 主 Agent 提案；Task Engine 判断依赖、范围、重复节点、验收条件；Orchestrator 校验授权、深度、预算、Agent 容量和写入冲突。
- 默认最大深度 2（Root=0、Team=1、Worker=2）；Worker 默认不得继续委派。
- 同一根任务共享总预算：`maxConcurrentAgents`、`maxTotalAgentRuns`、`maxTaskNodes`、`maxRetries`、`tokenBudget`、`timeBudget`。阈值需可配置，本轮可保守起始。
- Worker 只能接受自己 scope 范围内子任务。Planner 不直接写 DAG。
- 被验收通过的工作才算成功；连续无进展、预算耗尽、依赖死锁或无限重试时要进入 `blocked/failed/needs_human` 而非继续递归。
- 代码写入范围重叠时必须串行化或分配真实隔离 Worktree，提示词不算文件隔离。

## 上下文与交付

| Agent 类型 | 上下文 | 生命周期 |
|---|---|---|
| Root Supervisor | 根目标、计划、关键进度、待处理决策；不注入全部工具日志 | 跟随根任务，事件唤醒 |
| Team Agent | 模块状态与决策、当前任务、必要记忆和引用 | 任务完成进入 Idle；可恢复 Session |
| Temporary Worker | Fresh Session、目标、约束、必要代码和产物引用、交付格式 | 本次 Attempt 完成后释放 |

Worker 交付需含 `summary`、`artifactRefs`、`evidenceRefs`、`remainingRisks`、`resultStatus`，不要直接返回完整推理/工具日志；父 Agent 需要细节时按引用查询。

## 主 Agent 持续参与的正确含义

主 Agent 保持**持续协调责任**，不是保持 LLM 无限循环。Task/Agent 生命周期事件按重要性筛选后唤醒 Root；普通 Token、逐条 Tool 事件只进中台与日志，不都塞进 Root 上下文。用户追加说明亦作为受控消息注入。
