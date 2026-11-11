# Zlo Agent 0.5.0 · 验收报告

本轮以公开仓库 main 的 `a0ab153` 为基线，保留 Pi Runtime、Task Engine、Orchestrator、Capability Gateway 和 Electron 进程边界。实施缺口见 [开发计划](20-desktop-management-plan.md)，桌面数据契约见 [管理接口](21-desktop-management.md)。

| 领域 | 已实现 | 验证 |
| --- | --- | --- |
| 执行与验收 | 独立验收结论和旧快照兼容，Root、Team、Worker 共享判定原则 | 无检查文本与工具回执、失败工具、缺产物、已验收、重启恢复 |
| 模型与账号 | 四个 API Provider、加密存储、实际目录、连接测试、会话和默认模型、选模策略 | 实际 DeepSeek 推理、加密存储及 Host 重启；OAuth 回环、PKCE、签名和 Responses 请求测试 |
| 权限与工具 | 默认和会话权限、原生提权、运行中撤销、工具策略与审批记录 | 运行中权限收紧、持久化、已暴露工具的后续调用被拦截 |
| 任务、记忆与诊断 | DAG、Agent Tree、执行记录、会话记忆、用量预算、离线诊断 | Windows Electron 任务与设置场景、恢复以及凭证脱敏检查 |
| 未知副作用 | 文件摘要核对、Git 状态和进程号观察 | 真实工作区文件、重启、跨会话拒绝、摘要不符保留阻塞、匹配后转入可恢复状态 |
| Judgment | 六个决策点记录结构化候选、基线、选择和结果关联 | 实际调用链、候选限制、离线关联、数据最小化 |

## 本地验收

- Host TypeScript 检查和 116 项测试通过。
- UI TypeScript 检查和 27 项测试通过，包括 Shared Contracts 边界与 OAuth 回环。Windows 受限工具环境阻止本地回环连接，使用普通 Windows 进程权限复验通过。
- Windows Electron E2E 3/3 通过，覆盖原有对话、换模、停止、Host 崩溃和恢复，以及新版设置、权限、记忆、诊断、用量和 Renderer 凭证隔离。
- 真实 DeepSeek 测试使用独立用户配置。通过设置页添加本机已有的授权凭证，加载真实模型目录，选择 `deepseek-flash`，真实模型回复 `READY`。该轮显示执行完成和未验收。Host 重启后恢复默认模型及加密凭证。测试仅在 Main 自动提供剪贴板内容与原生确认结果，Renderer 和 Host 使用实际实现。
- 已启动打包后的 Windows x64 应用并确认 0.5.0 版本、真实 Pi Host、四个 API Provider 和 ChatGPT 账号状态。

`Desktop CI` 在 Windows runner 上检查 Host 和 UI 类型、全部测试、共享契约边界、Electron E2E 和便携包，成功后保存构建产物。工作流无需供应商凭证。

## 待现场验收与限制

ChatGPT 接入采用 OpenAI 的 [开源应用授权](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) 和官方 Responses 路径。自动化覆盖授权参数、回环、身份令牌校验、独立账号路由、请求适配与预算。真实账号的网页授权与第一次推理需要账号持有人确认，未将该场景计为通过。

记忆、用量和任务管理按当前会话显示。成本为 SDK 可提供的估算，预算硬限制仍使用 Token，订阅余额保持未知。未知操作缺乏可验证后置条件时继续阻塞；Git 与进程状态只提供证据。项目命令仍按当前用户权限执行。
