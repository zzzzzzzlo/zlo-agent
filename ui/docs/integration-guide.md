# Electron 与 Agent Host

重构 Renderer 时可先阅读 [后端功能与接口](../../docs/29-frontend-backend-handoff.md)，其中列出当前桌面 API、可用页面数据与验收边界。

Electron 主进程使用自身附带的 Node 启动独立 Host，通过 stdin/stdout 的版本化 JSONL 通信。应用启动会等待 `ready`。Host 退出或握手超时后 UI 显示离线，可从 UI 重新启动。窗口关闭时发送 `exit`，等待 Host 停止、刷盘并释放写锁。

Preload 通过 `window.agentHost` 暴露固定的 `DesktopHostApi`。Main 校验主框架来源、参数及工作区选择，Renderer 保持 sandbox、contextIsolation 和关闭 Node 集成。文件路径只由系统选择器授权。Host 继续校验路径边界、链接和文件类型。

`HostAgentAdapter` 将业务命令发送到 Main。Zustand 按 Conversation 渲染快照和事件。打开会话时从 `getHistory` 取得历史与游标，再订阅该游标之后的事件。重连后重新获取快照和游标。用户消息只发送 Conversation ID、请求 ID 与本轮文本。Host 独立恢复 Pi 上下文。

`sendMessage` 创建 Task。运行中追加用 `steerConversation`。停止确认与最终 `stopped` 分开。用户可以通过活动面板看到工具和用量，失败、停止与待核对各有自己的状态。归档保留审计历史。

具体 wire 方法、事件、运行 ID 与兼容性见 [Sprint 4 协议](../../docs/11-desktop-protocol.md)。
