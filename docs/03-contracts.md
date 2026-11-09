# 03 · 核心契约草案（语义优先）

接口是设计草案，不承诺与 Pi 现有 API 完全同名。Codex 需要在实现时根据实际 SDK 版本适配，而不是修改 Pi 源码以迎合本草案。

## 基本身份关系

- `TaskId`：用户目标的稳定标识；一项任务对应多次执行和多个子任务。
- `TaskRunId`：根任务的一次执行周期，停止后再次恢复可以继续原 Run 或启动新 Attempt，但必须可审计。
- `TaskNodeId`：DAG 节点；`parentNodeId` 是范围归属（分解层级），`dependencies[]` 是执行依赖（可跨同级）。二者不能混淆。
- `TaskAttemptId`：一个节点的一次执行尝试，含重试记录。
- `AgentId`：持久角色实例（Root/Team/Temporary）；`AgentRunId`：一次激活/执行。
- `SessionId`：Pi 的真实 Session 身份；可能在 Agent Run 间继续使用。
- `OperationId`：具副作用工具操作的幂等/核对身份；`ArtifactId`：工作产物版本引用。
- `EventId` 与 `seq`：事件去重与按 Task 的单调顺序。

## 状态机（最小目标）

```ts
type TaskStatus =
  | 'created' | 'ready' | 'blocked' | 'running' | 'verifying'
  | 'succeeded' | 'failed' | 'stop_requested' | 'stopping'
  | 'stopped' | 'needs_reconciliation' | 'cancelled';

type AgentLifecycle =
  | 'created' | 'starting' | 'active' | 'idle'
  | 'stopping' | 'stopped' | 'failed';

type AttemptStatus =
  | 'queued' | 'running' | 'awaiting_verification'
  | 'succeeded' | 'failed' | 'interrupted' | 'unknown_effect';
```

状态转移必须显式验证、原子提交；任何外部的模型/工具结果只是**请求转移的证据**。根任务成功必须经过验收；停止与取消不可混淆：`stopped` 可恢复，`cancelled` 是明确放弃。支持 `blocked` 等待依赖、`needs_reconciliation` 防止未知效果重试。

## Port 接口草案

```ts
interface TaskEngine {
  createTask(cmd: CreateTaskCommand): Promise<{ taskId: string }>;
  proposePlan(cmd: PlanProposal): Promise<{ acceptedNodeIds: string[] }>;
  reportAttempt(result: AttemptOutcome): Promise<void>;
  requestStop(cmd: StopCommand): Promise<{ accepted: boolean; state: TaskStatus }>;
  resumeTask(cmd: ResumeCommand): Promise<{ accepted: boolean; state: TaskStatus }>;
  addUserInstruction(cmd: UserInstructionCommand): Promise<void>;
  getSnapshot(taskId: string): Promise<TaskSnapshot>;
}

interface MultiAgentOrchestrator {
  dispatch(node: TaskNode, context: ExecutionContext): Promise<AgentRunHandle>;
  requestDelegation(caller: AgentIdentity, req: DelegationProposal): Promise<DelegationDecision>;
  quiesce(rootTaskId: string): Promise<void>;
  recover(rootTaskId: string): Promise<RecoveryReport>;
}

interface AgentExecution {
  start(config: AgentRunConfig): Promise<AgentRunHandle>;
  requestStop(agentRunId: string): Promise<void>;
  resume(agentId: string): Promise<AgentRunHandle>;
  getSessionRef(agentRunId: string): Promise<SessionReference>;
}

interface ModelResourceScheduler {
  allocate(requirement: ModelRequirement, scope: TaskScope): Promise<ModelRouteReservation>;
  reconcile(reservationId: string, usage: ModelUsage): Promise<void>;
  requestSwitch(agentId: string, target: ModelRoutePreference): Promise<ModelSwitchOutcome>;
}

interface JudgmentKernel {
  evaluate<I, O>(specId: string, input: I): Promise<DecisionResult<O>>;
}

interface ContextBuilder {
  build(request: ContextRequest): Promise<TaskContextPackage>;
}

interface MemoryCore {
  recall(query: MemoryQuery): Promise<MemoryCandidate[]>;
  proposeCapture(source: TaskEvidence): Promise<void>;
}

interface CapabilityGateway {
  describeAllowedTools(principal: AgentIdentity): Promise<ToolSpec[]>;
  authorize(principal: AgentIdentity, action: ToolInvocation): Promise<AuthorizationDecision>;
}

interface SandboxProvider {
  prepare(policy: ExecutionIsolationPolicy): Promise<SandboxHandle>;
}

interface EventPublisher {
  publish(event: AgentEvent): Promise<void>;
  subscribe(cursor: EventCursor, sink: EventSink): Promise<Unsubscribe>;
}
```

`TaskSnapshot`、`CreateTaskCommand` 等 DTO 的最终字段应以类型检查和调用方需求为准；不强制一开始把所有可选未来功能实现。

## 必须明确的消息规范

```ts
type AgentEvent = {
  schemaVersion: 1;
  id: string;
  type: string;
  occurredAt: string;
  taskId: string;
  seq: number;
  taskRunId?: string;
  taskNodeId?: string;
  taskAttemptId?: string;
  agentId?: string;
  agentRunId?: string;
  sessionId?: string;
  parentAgentRunId?: string;
  correlationId?: string;
  causationId?: string;
  payload: Record<string, unknown>; // 已经脱敏/按 schema 验证
};
```

关键事件建议 `task.created / task.state_changed / task.stop_requested / task.stopped / task.resumed / task.plan_changed / agent.started / agent.finished / tool.started / tool.finished / model.usage / model.route_changed / judgment.evaluated / memory.recalled / verification.finished`。文本流式事件可以是可丢弃/可重建的展示信号；**状态与控制事件必须可靠持久化后发布**。

## Command 不等于 Event

`requestStop(requestId)` 是命令，必须返回接受结果；`task.stopped` 是真实持久化状态之后的事件。不能以发出事件替代操作执行。命令请求要有 `requestId`/幂等语义。

## 可演进与迁移

所有持久化对象有 schema version；迁移是显式操作。UI 与 Memory 仅依赖 DTO / Port，不能解析 Pi 内部 JSONL 结构作为长期协议。
