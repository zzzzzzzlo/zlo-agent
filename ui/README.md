# Zlo Agent 桌面版

面向 Windows x64 的本地 Coding Agent。Electron 自动启动独立 Agent Host，通过受限 IPC 提交命令和接收事件。对话、Pi Session 和任务记录保存在本机。

## 安装与启动

从仓库根目录使用 Node.js 24 和 npm。

```powershell
npm.cmd ci --prefix host --ignore-scripts
npm.cmd ci --prefix ui
Set-Location .\ui
npm.cmd run dev
```

正式桌面模式使用 Pi v1.5.0。先在启动 Electron 的环境中配置官方 Provider 的凭证，再在新建会话时输入 Provider 与模型 ID。受支持的环境变量为 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`（或 `ANTHROPIC_AUTH_TOKEN`）、`GEMINI_API_KEY` 和 `DEEPSEEK_API_KEY`。也可用 `ZLO_AGENT_MODEL_PROVIDER` 与 `ZLO_AGENT_MODEL_ID` 设置新会话的默认路由。应用使用系统环境读取凭证。

```powershell
npm.cmd run build
npm.cmd start
npm.cmd run pack:win
```

`pack:win` 会构建 Windows x64 便携版并输出到 `release/`。安装包附带 Host 生产依赖和 Electron 内置 Node。用户配置和 SQLite 位于 Electron 的 `userData`，其中 `agent-data/pi` 保存正式会话，`workspace` 是普通对话的默认只读工作区。

## 使用

- 新建会话时可指定模型。要修改项目文件，先通过系统选择器指定工作区，再选择「受控文件写入」。可以按需填写相对验收文件及必含文本。省略文件验收也能写入。
- 如需执行项目脚本或使用项目命令验收，选择「受信任项目执行」并在系统弹窗中确认。验收支持 `npm test`、`npm run build`、`npm run lint`、`npm run typecheck`。用相对目录指定脚本所在包，工作区根目录填写 `.`。npm 命令需要本机安装 npm。
- 受信任的脚本直接以当前用户身份运行，能访问该用户有权访问的文件和网络。仅在信任代码及其依赖的项目中开启此权限。
- Enter 发送，Shift + Enter 换行。运行中可以追加指令或停止。任务完成后，在原会话发送新消息会创建新 Task 并继续使用原 Pi Session。
- 标题栏的会话模型设置支持同 Provider 换模。已连接的会话会先显示待应用模型，确认后更新当前模型。
- 活动面板显示工作区权限、工具、协作节点状态与 Token 用量。停止完成后可以恢复。未知写入会单独显示为待核对状态。
- 重启应用会加载 Host 中的对话历史。会话菜单支持重命名和归档。外观、当前选择及草稿保存在本地 UI 偏好。

脱敏诊断保存在 `userData/logs/diagnostics.jsonl`，含当前文件和两份轮转文件。

## 开发验收

```powershell
npm.cmd test
npm.cmd run test:desktop
```

桌面自动化测试用官方 Faux Provider 驱动真实 Electron 与 Pi SDK。也可手动设置 `ZLO_AGENT_DESKTOP_MODE=faux` 后运行未打包的 Electron。开发服务器上的独立 Mock 演示可用 `VITE_ZLO_AGENT_MODE=mock` 显式开启。

- [窗口、IPC 和数据流](docs/architecture.md)
- [桌面接入指南](docs/integration-guide.md)
- [共享协议](../docs/11-desktop-protocol.md)
- [验收与代码审查](../docs/12-sprint4-verification.md)
- [许可和第三方说明](THIRD-PARTY-NOTICES.md)
- [第二轮遗留问题修复报告](../docs/13-sprint4-repair-report.md)
