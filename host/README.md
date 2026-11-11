# Zlo Agent Host

Host 是独立的 Node 24 进程。客户端通过标准输入发送 JSONL 命令，标准输出返回响应和事件。Electron 原型位于仓库的 `ui/` 目录。

## 安装与离线运行

在 PowerShell 中进入仓库的 `host/` 目录。

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run typecheck
npm.cmd test
```

完整文件权限测试在普通本地文件系统上需要能够创建链接及覆盖重命名。受限的 Codex 沙箱可能拒绝这些测试操作。

准备一个独立的空目录。以下命令会生成可直接粘贴到 CLI 的 JSON。

```powershell
$demoPath = Join-Path $env:TEMP ("zlo-demo-" + [guid]::NewGuid().ToString("N"))
$demoPath = (New-Item -ItemType Directory -Path $demoPath).FullName
@{
  schemaVersion = 1
  type = "createTask"
  requestId = "demo-1"
  goal = "demo delegate"
  cwd = $demoPath
  check = @{ path = "demo.txt"; contains = "verified by zlo agent" }
} | ConvertTo-Json -Depth 4 -Compress
npm.cmd run agent -- --fake
```

粘贴生成的 JSON，复制返回的 `taskId`。后续示例中的 `TASK_ID` 替换成该值。重复演示时请换一个 `requestId`。

```jsonl
{"schemaVersion":1,"type":"subscribe","taskId":"TASK_ID","after":0}
{"schemaVersion":1,"type":"getHistory","taskId":"TASK_ID"}
```

Fake 会创建 `demo.txt`，并让 Worker 读取后回传证据。可把目标改成 `demo delegate slow` 留出停止窗口。确认看到 `task.stopped` 后，使用同一任务 ID 继续。

```jsonl
{"schemaVersion":1,"type":"stop","taskId":"TASK_ID","requestId":"stop-1"}
{"schemaVersion":1,"type":"addInstruction","taskId":"TASK_ID","requestId":"note-1","text":"保留验收标记"}
{"schemaVersion":1,"type":"requestModelSwitch","taskId":"TASK_ID","requestId":"model-1","route":{"provider":"fake","model":"alternate"}}
{"schemaVersion":1,"type":"resume","taskId":"TASK_ID","requestId":"resume-1"}
```

停止活动 Worker、保存 Root 会话并恢复，以及 CLI 断线重连都可自动复现。

```powershell
node --disable-warning=ExperimentalWarning --test test/host.test.ts test/cli.test.ts test/recovery.test.ts
```

## 真实 Pi Smoke Test

在已配置并授权的环境中启动 `npm.cmd run agent -- --pi`。使用已配置的官方 Provider 环境凭证和显式 `route`。凭证通过进程环境读取，项目不要求粘贴到对话、命令 JSON 或仓库。内置直连 Provider 范围为 OpenAI、Anthropic、Google 和 DeepSeek，模型 ID 以 Pi v1.5.0 内置目录为准。没有可用路由时更换为已授权模型。

1. 在上述空目录提交 `createTask`，提供 `route: { "provider": "你的 Provider", "model": "已配置模型" }`。
2. 设置目标为「使用受控工具新建 demo.txt，内容为 verified by zlo agent。用 delegate_task 让 Worker 读取该文件并报告证据」。设置相同的文件验收。
3. 使用 `subscribe` 观察 Root/Worker 的 `agent.started`、`tool.finished`、用量和最终状态。
4. 用 `getHistory` 检查验收通过、Worker 的证据以及 Root 的 Session ID。测试 Stop/Resume 时先等 `task.stopped`，再比较恢复前后的 Root Session ID。

自动化测试用官方 Faux Provider 走真实 Pi Loop、工具、流式事件、Stop/Resume、会话与换模。在线 Smoke Test 需要另外执行。

## 命令和事件

每条命令与响应包含 `schemaVersion: 1`。命令可附带 `commandId` 关联当前响应。所有写命令使用 `requestId` 幂等，相同 ID 和参数返回历史结果。回放应继续使用客户端最后处理的 `seq`。

| 命令 | 参数 |
| --- | --- |
| `createTask` | `requestId`、`cwd`（绝对本地工作区路径）、`goal`、`workspaceAccess?`、`check?`、`route?` |
| `listTasks`、`getRouteStatus`、`exit` | 无 |
| `getTask`、`getHistory` | `taskId` |
| `addInstruction` | `taskId`、`requestId`、`text` |
| `addTask` | 兼容单叶委派。 `taskId`、`requestId`、`goal`、`expectedVersion`，依赖为空 |
| `proposePlan` | `taskId`、`requestId`、`expectedVersion`、`nodes`，批次可通过 `ref` 引用同级依赖 |
| `replanNode` | `taskId`、`requestId`、`expectedVersion`、`nodeId`、`update` |
| `discoverModels`、`getModelBudget` | 分别接受可选 `provider` 与必需 `taskId` |
| `requestModelSwitch` | `taskId`、`requestId`、`route: { provider, model }` |
| `stop`、`resume` | `taskId`、`requestId` |
| `subscribe`、`events` | `taskId`、`after?`（排除该序号） |
| `unsubscribe` | `taskId` |

`stop_requested` 表示已接受请求。终态以 `task.stopped` 或快照为准。事件带独立 Task、Node、Attempt、AgentRun 与 Session ID。文本流以 `kind: "output"` 实时输出，SQLite 游标用于回放持久化领域事件。Pi Session 保存对话和工具返回。换模在当前完整 Pi 轮次收敛后生效，保留根会话。Host 仅允许同 Provider 换模，实际供应商额度标记为 `unknown`。

## 数据与恢复

默认数据目录为 `%LOCALAPPDATA%\ZloAgent\fake` 或 `%LOCALAPPDATA%\ZloAgent\pi`。可用 `--data <目录>` 选择其他本地目录。数据目录须与工作区分离。SQLite 文件保存 Task、Attempt、命令、操作回执和事件，`sessions/` 保存 Pi JSONL。会话可能包含工作区内容，按本地私有数据管理。

- Host 同时执行一个根任务。DAG 可并行调度依赖已通过的独立只读节点，写操作在共享工作区串行。Team 按作用域复用 Pi Session，临时 Worker 每次激活新建 Session。每个根任务最多八次 Attempt，子 Agent 每次运行最多八个模型请求及 60 秒，根 Agent 每段运行最多 32 个请求及 10 分钟。
- `workspaceAccess` 接受 `read`、`write`、`trusted`。文件写入可以独立授权。项目命令及 Git 检查需要 `trusted`，它们按本机账户运行。 `check` 可使用 `{path, contains?}` 或在信任模式使用 `{command: {command: "npm_test", path: "."}}`。实际工具调用仍检查节点权限和路径。
- 发生未知写入、会话损坏或停止超时，查看 `getHistory` 的原因、操作 ID、工具与目标路径。在本地核对文件现状后，可用新任务描述剩余工作。此版本没有自动解锁或回滚未知写入的命令。
- SQLite 和 JSONL 各自有刷盘边界。断电跨存储原子性及 Windows 目录元数据的刷盘无法保证。中断期间尚未确认交付的说明可以再次进入上下文。

## 桌面 Conversation

桌面启动与用户操作见 [桌面手册](../ui/README.md)。[Sprint 4 桌面协议](../docs/11-desktop-protocol.md) 定义 `createConversation`、`getConversationHistory`、`sendMessage`、`steerConversation`、`stopConversation`、`resumeConversation` 与游标订阅。Host 保留既有 Task CLI，同时在 Conversation 上提供产品级历史。使用 `--faux` 可通过官方 Faux Provider 运行真实 Pi SDK 的离线开发场景。

第三轮新增的 [中台事件](../docs/16-observability-contract.md) 与 [可替换 Judge](../docs/15-jev-integration.md) 沿用每个 Task 的事件回放边界。

## 工具系统

默认 Coding Profile 的工具清单与权限见 [工具系统说明](../docs/18-tool-system.md)。新工具均通过 Capability Plugin 注册，并在执行时验证 Agent、Task 和路径权限。

CLI 在高风险操作前输出临时 `kind: "tool.approval"` 帧。受信任客户端通过 `resolveToolApproval` 命令提交 `approvalId` 和 `decision: { approved: boolean, destination?: string }`。导出目的地由明确的系统保存操作提供。审批 60 秒超时，任务停止后拒绝迟到回复。桌面端由 Electron Main 原生对话框处理该协议。
