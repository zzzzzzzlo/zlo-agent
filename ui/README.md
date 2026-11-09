# Zlo Agent

面向 Windows 的个人 AI Agent 桌面客户端首版。窗口默认采用浅色黑白灰配色和磨砂透景，Windows 11 22H2 及以上通过系统亚克力模糊后方窗口。通过内置 Mock 会话体验发送、流式回复、工具状态和停止操作。所有演示都在本地完成，无需模型密钥或配套服务。

## 安装与启动

UI 是主工作目录下的独立 `ui/` 包。需要 Windows 10/11（x64）、Node.js 22.12+ 或 24+（x64）和 npm。从主工作目录启动时，先进入 UI 包：

```powershell
cd .\ui
npm ci
npm run dev
```

首次启动可能需要下载 Electron 二进制。开发命令会启动可拖动和缩放的 Electron 窗口。构建与运行生产版本可使用以下命令。

```powershell
npm run typecheck
npm run build
npm start
```

### Windows 便携版

```powershell
npm run pack:win
```

打包输出到 UI 包内的 `release/`。现有最新版是 [圆角便携版](release/Zlo-Agent-0.1.0-win-x64-rounded-portable.exe)，双击即可启动。便携版会把程序解压到临时目录运行。外观偏好与演示会话保存在当前 Windows 用户的 Electron 配置目录。

## 界面操作

- 左侧可新建、切换会话。在会话右端打开菜单可以重命名或删除。使用标题栏按钮收起、展开侧栏。
- 在欢迎页选一个示例即可填入输入框。Enter 发送，Shift + Enter 换行。回复生成时，输入框右侧切换为停止按钮。
- 发送「演示错误状态」会展示模拟失败。发送其它文本会依次看到工具运行、完成和流式回复。点开工具卡片可查看演示详情。
- 标题栏右侧可打开活动面板。模型和附件入口会说明当前接入状态。
- Ctrl + N 新建会话，Ctrl + , 打开设置。设置中提供深色、浅色和三档玻璃强度，同时控制后方桌面的显现程度。

## 文档

- [实施计划](docs/implementation-plan.md)
- [架构与 Liqui Design 用法](docs/architecture.md)
- [Pi Agent 接入指南](docs/integration-guide.md)
- [Windows 验证记录](docs/verification.md)
- [许可和第三方说明](THIRD-PARTY-NOTICES.md)
