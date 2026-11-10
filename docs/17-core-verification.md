# 第三轮 · 实施报告

## 交付与取舍

- **工作区与权限**。用户可创建只读、文件写入或信任项目代码的会话，文件验收可选。Host 在运行时按角色、工作区和节点作用域再校验。文件工具支持目录创建、文本读写和受控编辑。信任模式增加 Node 脚本、npm test/build/lint/typecheck 和本地 Git 状态、差异、日志。项目命令采用固定参数形态、清理子进程环境、限制输出，执行前持久化写操作回执。
- **DAG 与协作**。Task Engine 原子写入计划版本、节点、依赖、执行和验收记录。Root 使用计划工具或独立 Task JSONL 命令提交 DAG。Team 以会话、Team Key、授权 Provider、访问级别和路径决定复用身份，临时 Worker 每次新建 Session。父子交付用结构化结果，依赖以可核对的证据引用传递。写节点串行，独立读节点有界并发。
- **上下文与记忆**。上下文注入遵守保守字节预算。Pi 通过自身 Session 压缩保存长对话投影。Memory 从已验收文件操作和检查提取事实与经验，按作用域、Provider、来源、版本持久化，之后在相关任务按词项召回。
- **模型资源**。Pi 目录注册、凭证检查和显式选模沿用 SDK。Scheduler 从已授权模型中按能力和价格估算为子任务独立选模，持久化请求预留与用量核销。没有可靠回执时保守记为 uncertain。相同 Provider 的热切换保留 Session。
- **扩展与判断**。可信 Host 组装可注册 Capability Plugin、Agent Profile 和 Workflow Pack，Coding 为内置实例。六个规则决策点接入实际调用链，可选 Shadow/Active，见 [Jev 接入](15-jev-integration.md)。Desktop Activity Panel 从 durable event 和历史快照显示 Team/Worker 节点状态。
- **观测**。Task、Agent、工具、资源、记忆和决策事件经 Host 既有可重放事件接口提供，见 [中台数据契约](16-observability-contract.md)。

## 边界

- 共享工作区写入在同一 Host 内串行，文件路径检查拒绝跨界路径和文件链接。信任项目的 Node/npm 命令和 Git 按本机账户权限运行，允许项目自身执行代码。Windows 进程树取消为尽力而为，已启动而结果不明的动作进入 `needs_reconciliation`。界面保留检查证据，目前需要用户人工核对实际文件或进程后创建新工作。
- 依赖边限定在同一父节点下。默认每根 Task 最多 16 个节点和 32 次子节点激活，同时最多四个子节点并为 Team 的 Worker 保留容量。每个节点最多一次重规划，产生过写回执的节点须用显式的新计划处理。
- Memory 当前为证据驱动提取和词项检索。桌面对话间默认隔离记忆，路径受限的子节点采用独立作用域。
- 资源预算在请求前按保守估算约束并按实际 Token 校正。Provider 账单、订阅配额和在线多模型质量评测未纳入本轮。跨 Provider Session 迁移及子任务传输保持拒绝。
- Plugin/Profile/Workflow 由受信任的 Host 集成者注册。Jev 在线服务、完整观测中台、系统级沙箱及任意 Shell/Git 修改操作留待独立范围。

## 验收记录

| 验收 | 实际结果 |
| --- | --- |
| Host `npm run typecheck` 与 `npm test` | 通过。80 项测试覆盖旧协议、读写边界、真实 Node/npm/Git、DAG、故障恢复、Team Session 复用、预算、扩展注册、记忆和判断模式。 |
| UI `npm run typecheck` 与 `npm test` | 通过。24 项测试覆盖 IPC、权限、诊断、历史投影与节点进度。 |
| Windows Electron E2E | 2 项通过。使用真实 Electron、Pi SDK 和官方 Faux Provider。验证停止与进程崩溃后的恢复、换模、无验收文件写入、原生信任确认、npm 验收及 Team/Worker 活动显示。 |
| 随包 Pi Host | 使用 Electron 内置 Node 完成握手及退出。用隔离目录和真实 DeepSeek `deepseek-flash` 完成文件创建，核对内容与验收状态。 |
| Windows x64 便携包 | `npm run pack:win -- --config.directories.output=release/core-0.3.0` 通过。解包应用在隔离用户目录打开窗口、启动 Pi Host 并查询会话列表。打包期间的一次启动超时在复测中未再出现。 |

产物 `Zlo-Agent-0.3.0-win-x64-portable.exe` 为 116,533,209 字节。SHA-256 为 `5B00200E197DA6661C51C0E0219F476C63E862B907BF011BB3C0FD8629149154`。

| 本地提交 | 交付 |
| --- | --- |
| `5ce8518` | 版本化 Task DAG、调度和恢复 |
| `c9aca56` | 工作区工具、真实命令与验收 |
| `9e221a0` | Team、模型预算、记忆、扩展和六个决策点 |
| `bd2eac8` | 桌面授权、运行投影和 0.3.0 版本 |

WorkBuddy 独立检查了分层停止与释放、写操作重规划及 Team 身份复用。较长的审查请求出现超时。实际验收以仓库内测试和本机运行证据为准。

## 手工复现

1. 启动桌面版，选择一个空的本地工作区，保留文件写入权限并留空验收字段。发送「使用文件工具创建 `hello.txt`，内容为 `hello`」。在活动面板和本地目录核对回执及文件。
2. 在已信任且有 test script 的项目创建新会话，选择信任项目代码和 npm test 验收。确认系统授权后提交任务。分别检查实际退出码对应的验收状态。
3. 在 Coding 会话要求 Root 先安排 Team 实现，再由独立 Worker 检查产物。在活动面板核对节点进度。停止正在执行的任务并在可恢复状态继续，核对历史里的 Attempt 和节点。
4. 在 Host 的 `events` 命令以同一个 Task Cursor 分段回放，检查 Agent、模型预留、用量、记忆和 Judgment 事件。遇到 `needs_reconciliation` 时，用工具回执核对本地状态再创建剩余任务。
