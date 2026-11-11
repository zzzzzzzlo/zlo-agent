# 0.5.0 · 桌面管理与接口

## 任务执行与验收

`TaskStatus` 兼容旧客户端。 `succeeded` 表示本次运行完成，`verification.verdict` 给出独立验收结论。通过声明的文件或项目命令检查才得到 `verified`。文本、成功工具回执及通过协作收敛的交接可作为执行事实，无预设检查的目标保留 `unverified`。确定性检查失败保留 `failed`。Root、Team、Worker 使用相同验收规则；子节点可交付有证据的工作供 DAG 继续，但交付状态不会替代验收结论。已落盘的历史回执保持原样，旧快照在读取时保守解释。

六个 Judgment 决策点由 [Jev 接入说明](15-jev-integration.md) 定义。离线评测通过 [观测契约](16-observability-contract.md) 关联 Task、Attempt、Node、AgentRun、模型请求和决策结果。

## 设置与凭证

- 在设置的模型与账号选择 DeepSeek、OpenAI、Anthropic 或 Google Gemini。复制供应商 API Key 后点击添加。系统确认窗口同意后，Electron Main 读取并验证剪贴板内容。平台凭证存储使用 Electron safeStorage；Windows 使用 DPAPI。可测试连接，选择具体模型时会发起短推理。设置页只显示凭证状态、目录和连接结果。
- 可设默认模型并为会话选择模型。自动策略可在同 Provider 内为子任务独立选型，固定策略沿用父模型。新会话未显式选模或配置默认路由时，会从已授权的 API Provider 选择可用模型。正在使用的 Pi Session 只接受同 Provider 的路由变化。
- DeepSeek 思考模型的单次输出预算最高为 16384 Token，包含思考、正式回复和工具调用参数，仍受模型上限和任务总预算约束。思考内容由本地 Pi 会话保存，供该 Provider 的连续工具调用使用。聊天只展示正式回复，诊断日志记录触顶状态。模型触顶时，任务保留可恢复的阻塞状态，并明确提示输出上限。
- 删除密钥会持久化停用记录，防止重启时旧启动环境重新启用该 Provider。更新或删除凭证会先让使用该 Provider 的活动和待执行任务停止。之后可选择适用模型并继续。提供方不可用或额度未知时界面如实显示。
- ChatGPT 账号走 OpenAI 的本地开源应用授权。系统浏览器授权、回环 PKCE、签发的应用客户端 ID 和 ID token 验证在 Main 完成。该路由按本地账号配置隔离，使用官方 Responses API 和对应 ChatGPT 计划。登录可取消，可重新授权已保存的配置，登出可查看远端撤销是否确认。OpenAI API Key 仍使用独立 API 计费。

OAuth 规格与可用性见 [OpenAI 注册和登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) 和 [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。ChatGPT 目录反映账户授权返回的模型，实际可用性仍由推理请求确认。API 目录在连接测试后取供应商目录和 Pi 能力交集；重启后显示待测试的 SDK 目录，直至重新连接验证。

## 权限、状态与核对

- Read、Write、Trusted 是针对工作区的授权。会话提权必须通过原生确认，并在确认前后核验目录。运行中收紧授权时，Host 原子保存会话和活动任务的限制，立即发出停止请求；恢复使用收紧后的权限。默认 Trusted 对每个新工作区仍需确认。
- 禁用工具后，Capability Gateway 拒绝后续调用，并通知活动任务收敛。原生工具授权回执可在会话安全视图查看。Shell 与项目命令仍按当前系统账户运行。
- 设置显示最近 20 个会话任务及其 DAG、Agent Tree、工具调用、有效权限、模型、用量和预算；消息完整历史继续使用 Conversation 分页。Memory 可按所选会话读取和删除，删除影响后续检索。近期诊断只读固定字段和脱敏摘要，Host 离线时仍可查看。
- `needs_reconciliation` 中，文件创建工具在执行前记录工作区身份和预期内容摘要。若后端只读核对发现目标文件与摘要一致，且该任务不存在其他未核对效果或检查点问题，任务进入可恢复的 `stopped`。核对过程不执行原操作。Git 状态和进程号只用于检查线索，进程号可能复用；原操作结果未证实、旧回执缺少预期摘要或外部副作用未确认时，任务保留阻塞。

## 进程与协议

`shared/contracts/management.ts` 定义 `window.agentManagement`，`shared/contracts/chatgpt.ts` 定义 `window.agentChatGpt`。现有 `window.agentHost` 及 JSONL v1 信封保持兼容。

| Preload 方法 | Main / Host 处理 |
| --- | --- |
| `snapshot`、`recentDiagnostics` | 读取有界的 Host 管理投影、应用版本和经过验证的诊断文件 |
| `savePreferences` | Main 对权限放宽进行原生确认，Host 校验模型和保存策略 |
| `setWorkspaceAccess` | Main 校验目录和授权，Host 用预期权限防止并发覆盖 |
| `setProviderKey`、`testProvider`、`removeProviderKey` | Main 负责凭证，Host 用固定 Provider 接口核验并切换 Pi 配置 |
| `deleteMemory`、`reconcile` | Main 校验结构，Host 校验作用域、任务归属和操作证据 |
| `status`、`signIn`、`cancelSignIn`、`signOut` | Main 管理官方 OAuth 与本地凭证，Host 只收到运行所需的短期授权 |

Main 启动专用 Host 子进程，并在 Host 公告 ready 前从安全存储经私有 stdin 载入凭证。API Key、OAuth token 和私有传输命令均不经 Renderer、持久事件或诊断数据。管理命令只在 Main 创建的桌面传输启用。
