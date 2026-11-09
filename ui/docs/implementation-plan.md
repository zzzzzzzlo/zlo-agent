# Zlo Agent 实施计划

## 参考核对

- [PI-Desktop](https://github.com/vastsa/PI-Desktop/tree/7a3d585c3744f14bafb2fac67295227e31de4950) 使用 LGPL-3.0，主仓包含 `apps/desktop`（Electron、React、TypeScript、electron-vite）、Rust 宿主及运行时包。核对了 `src/main.tsx`、`App.tsx`、`features/app/AppShell.tsx`、`components/{Sidebar,ChatSurface,Composer,WindowControls}.tsx`、`features/settings/SettingsPage.tsx`、`styles/{chrome,composer,sidebar-threads,settings}.css` 和 [中文聊天截图](https://github.com/vastsa/PI-Desktop/blob/7a3d585c3744f14bafb2fac67295227e31de4950/docs/image/readme/chat_zh.png)。沿用三栏结构、会话选中态、居中消息列、底部输入坞、紧凑的窗口控制和分区设置。此项目独立实现界面。
- [Liqui Design](https://github.com/leefanv/liqui-design) 使用 MIT。`apps` 提供文档和基于 Base UI 的 shadcn 源码注册表，`packages/glass` 发布官方内核。核对了[安装方式](https://liqui.design/docs)、`LiquiGlass`、`LiquiThemeProvider` 和 Design Tokens。直接安装 `@liqui-design/glass`，使用官方基础表面与主题 Provider，并将光学参数和应用色板集中管理。Chromium 自动使用 SVG 位移滤镜，兼容分支与手动低负载档使用磨砂。

## 版面和材质

```text
┌─ Zlo Agent ──┬─ 当前会话 ────────────────── Mock 模型 · 工具 · 窗口 ┐
│ 新建会话     │                                                      │
│ 会话历史     │            欢迎页 / 居中消息列           可折叠活动栏 │
│              │                                                      │
│ 设置         │                   底部玻璃输入坞                     │
└──────────────┴──────────────────────────────────────────────────────┘
```

默认浅色采用雾白 `#F5F5F5` 和墨灰 `#202020`，深色由炭黑 `#0D0D0D`、石墨 `#252525` 和灰白 `#F9F9F9` 构成。Segoe UI Variable 与微软雅黑负责正文和标题，Cascadia Mono 负责快捷键与运行状态。欢迎页保留轨道徽记。按视觉反馈移除彩色光带和点阵，参照用户提供的图片使用磨砂透景、细高光和较柔和的玻璃圆角。

## 实施顺序

1. 建立 Electron 主进程、沙盒 preload、Vite/React 19 与 Tailwind v4。自定义标题栏，桥接窗口操作和最大化状态。视觉复核后切换为支持原生边缘缩放的透明窗口，并验证 Windows 合成。
2. 实现会话存储和 `AgentAdapter` 的发送、订阅、取消、Steering 契约。Mock 事件驱动消息、工具与运行状态，按会话及运行 ID 隔离。
3. 完成欢迎、聊天、会话菜单、设置、活动面板。对浮层、按钮、输入坞应用 Liqui，对大表面使用磨砂。
4. 实际启动 Windows 窗口，验证会话和窗口交互、主题、滤镜、缩放和持久化，截图检查后修正，尝试生成便携版。
