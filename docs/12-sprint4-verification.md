# Sprint 4 · 验收与代码审查

## 实际开发环境

Windows x64，Node 24.15.0，Electron 43.4.1（内置 Node 24.18.1），Pi SDK 1.5.0。基线是 Git 提交 `877b4ef`。Sprint 4 在现有 Host 和窗口代码上增量开发，桌面包版本为 0.2.0。

## 自动化验收

| 命令 | 验收结果 |
| --- | --- |
| `npm.cmd run typecheck`，分别在 `host/` 和 `ui/` | 通过 |
| `npm.cmd test`，在 `host/` | 38/38 |
| `npm.cmd test`，在 `ui/` | 11/11 |
| `npm.cmd run build` 与 `node --test test/desktop-e2e.test.mjs`，在 `ui/` | 构建通过，Windows Electron 端到端 1/1，使用官方 Faux Provider |
| `npm.cmd run pack:win` 与随包 Host 启动检查 | 构建 Windows x64 便携包，随包 Electron 可启动 Pi Host、列出会话并正常退出 |

Host 覆盖 Conversation 消息与 Task 同事务、历史分页和 cursor、旧 CLI 兼容、Pi Session 复用、真实 SDK 运行中 steering、文件验收失败、停机、崩溃与回执。Windows 文件系统测试在具备临时目录链接权限的环境运行。

Electron 单测覆盖握手、请求关联、事件分帧、超时、子进程异常退出、重启、优雅退出和 IPC 输入约束。前端单测覆盖历史快照与订阅竞态、重复事件、序号缺口以及待核对状态。

Playwright 启动真实 Electron 和独立 Host。在沙箱 Renderer 中创建 Conversation，从界面发送创建登录页、添加验证码两条消息，验证磁盘文件、不同 Task/Run ID、同一 Pi Session、工具状态和 Token 用量。验证运行中追加指令、停止后保留部分回复、关闭 Electron 再打开并续聊。测试还强杀了该隔离 Electron 实例的 Host 子进程，从界面重启 Host，并验证部分内容、Attempt 和 Session 可恢复。目录选择器在测试中返回隔离工作区，主进程授权、Host 路径检查和文件工具执行真实逻辑。

便携包检查曾发现 electron-builder 跳过了资源根目录的 `node_modules`。已将 Host 生产依赖作为独立资源映射，并添加 `afterPack` 检查。修复后的随包 Host 完成了 Ready、命令和退出检查。

## 最终代码审查

- Conversation 由 Host 持久化。TaskEngine 掌管状态机，Orchestrator 掌管 AgentRun 与会话引用。新任务创建独立 TaskRun，重启恢复沿用安全的原 Attempt，主动停止后继续创建新 Attempt。旧 Task 入口限制对 Conversation 所有任务的变更。
- 用户消息与 Task 绑定、状态投影及事件使用同一 SQLite 事务。可见文本增量随游标落盘。崩溃后保留已提交内容，文件写入结果不明时进入 `needs_reconciliation` 并拒绝续跑。旧 Task 记录回填稳定 Run ID，历史事件保留原格式。
- Renderer 使用有限的 Preload 接口，主进程校验来源和每个参数。目录选择器授权独立工作区，Host 对实际操作进行二次路径检查。Host 标准输出只承载协议，子进程错误使用结构化码。IPC 无通用执行入口。
- 桌面和 CLI 共用 Host，桌面 Zustand 只保存展示投影。Pi JSONL 由运行时读取。外观、当前选择和草稿保存在本地偏好。旧原型的 Mock 历史保留在旧存储键中，正式端从 Host 加载会话。
- 普通对话只读，Coding 模式要求用户选择工作区与相对文件验收。V0 仍使用文件工具权限边界，系统级沙箱和人工核对后解锁留待后续。状态投影逐段写入 SQLite，长期大型会话的存储压缩尚未进行专项性能验证。

## 在线 Provider Smoke Test

进程、当前用户和系统环境均未发现受支持 Provider 的凭证，在线验证待执行。自动验收使用 Pi 官方 Faux Provider，走真实 SDK、文件工具和 Electron，且无需在线凭证。

在授权的 Windows 环境中按 [桌面手册](../ui/README.md) 配置 Provider 和模型，选择空工作区，验收文件设为 `login.html`。发送创建登录页与追加验证码两轮请求，观察流式文本、工具状态和验收。再提交一条长输出请求，在流式生成时点击停止。重新启动桌面确认已生成内容、状态和会话都能恢复。
