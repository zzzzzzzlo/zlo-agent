# 0.5.0 · 桌面管理与接口

## 任务执行与验收

`TaskStatus` 兼容旧客户端。 `succeeded` 表示本次运行完成，`verification.verdict` 给出独立验收结论。通过声明的文件或项目命令检查才得到 `verified`。文本、成功工具回执及通过协作收敛的交接可作为执行事实，无预设检查的目标保留 `unverified`。确定性检查失败保留 `failed`。Root、Team、Worker 使用相同验收规则；子节点可交付有证据的工作供 DAG 继续，但交付状态不会替代验收结论。已落盘的历史回执保持原样，旧快照在读取时保守解释。

六个 Judgment 决策点由 [Jev 接入说明](15-jev-integration.md) 定义。离线评测通过 [观测契约](16-observability-contract.md) 关联 Task、Attempt、Node、AgentRun、模型请求和决策结果。

## 工作台与凭证

- 在左侧打开「模型与账号」，从「API 接入」选择 DeepSeek、OpenAI、Anthropic 或 Google Gemini。复制供应商 API Key 后点击添加。系统确认后由 Electron Main 读取并验证剪贴板。凭证通过 Electron safeStorage 保存，Windows 使用 DPAPI。连接测试可指定模型并发起短推理。页面只接收凭证状态、模型目录和连接结果。「ChatGPT 账号」与「默认模型」各有独立入口，底部「设置」提供外观与版本信息。
- 可设默认模型并为会话选择模型。自动策略可在同 Provider 内为子任务独立选型，固定策略沿用父模型。新会话未显式选模或配置默认路由时，会从已授权的 API Provider 选择可用模型。正在使用的 Pi Session 只接受同 Provider 的路由变化。
- DeepSeek 思考模型的单次输出预算最高为 16384 Token，包含思考、正式回复和工具调用参数。Flash 默认使用低思考强度。若一轮只有思考且耗尽输出预算，Root 在权限、取消与任务预算校验下至多追加一次关闭思考的续接。恢复这种已阻塞的任务时，同一模型可直接使用该方式。续接保留已完成的工具结果，从发送给模型的上下文移除仅含思考的截断回复。Pi 本地会话保存原始记录，聊天只展示正式回复。续接仍因输出上限中断时，任务进入可恢复的阻塞状态。

思考强度和输出预算分开配置，参考 [DSH Provider 指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md) 和 [DeepSeek API](https://api-docs.deepseek.com/guides/thinking_mode/)。DSH 的[公开复现](https://github.com/deepseek-ai/deepseek-harness/discussions/12347)也记录了仅有思考内容时的空答复。Pi 负责拦截截断回复中的工具调用，Zlo 在 SDK 的正常请求路径上执行有限续接。

`model.output_recovery` 记录续接触发方式 `automatic` 或 `resume`，模型用量仍由每次请求各自的 `model.usage` 记录。
- 删除密钥会持久化停用记录，防止重启时旧启动环境重新启用该 Provider。更新或删除凭证会先让使用该 Provider 的活动和待执行任务停止。之后可选择适用模型并继续。提供方不可用或额度未知时界面如实显示。
- ChatGPT 账号走 OpenAI 的本地开源应用授权。系统浏览器授权、回环 PKCE、签发的应用客户端 ID 和 ID token 验证在 Main 完成。该路由按本地账号配置隔离，使用官方 Responses API 和对应 ChatGPT 计划。登录可取消，可重新授权已保存的配置，登出可查看远端撤销是否确认。OpenAI API Key 仍使用独立 API 计费。

OAuth 规格与可用性见 [OpenAI 注册和登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) 和 [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。ChatGPT 目录反映账户授权返回的模型，实际可用性仍由推理请求确认。API 目录在连接测试后取供应商目录和 Pi 能力交集；重启后显示待测试的 SDK 目录，直至重新连接验证。

## 权限、状态与核对

- Read、Write、Trusted 是针对工作区的授权。会话提权必须通过原生确认，并在确认前后核验目录。运行中收紧授权时，Host 原子保存会话和活动任务的限制，立即发出停止请求；恢复使用收紧后的权限。默认 Trusted 对每个新工作区仍需确认。
- 禁用工具后，Capability Gateway 拒绝后续调用，并通知活动任务收敛。原生工具授权回执可在会话安全视图查看。Shell 与项目命令仍按当前系统账户运行。
- 「Agent 与任务」显示最近 20 个会话任务及其 DAG、Agent Tree、工具调用、有效权限、模型、用量和预算。消息历史继续使用 Conversation 分页。Memory 可按所选会话读取和删除，删除影响后续检索。近期诊断只读固定字段和脱敏摘要，Host 离线时仍可查看。
- `needs_reconciliation` 中，文件创建工具在执行前记录工作区身份和预期内容摘要。若后端只读核对发现目标文件与摘要一致，且该任务不存在其他未核对效果或检查点问题，任务进入可恢复的 `stopped`。核对过程不执行原操作。Git 状态和进程号只用于检查线索，进程号可能复用；原操作结果未证实、旧回执缺少预期摘要或外部副作用未确认时，任务保留阻塞。

## 会话控制与中台

对话顶部显示生效中的模型、待应用的路由和工作区权限。权限变更走现有 Main 授权流程。右侧「中台」可在当前对话展开，显示会话累计 Token、模型请求、估算费用和工具调用。运行明细可切换已加载的轮次。

Host 按会话关联的全部已持久化任务计算累计值，覆盖尚未加载的聊天分页。Token 分为未缓存输入、输出、缓存读取和缓存写入。估算费用只累计有价格的用量报告，并展示价格覆盖数量。最近任务预算来自本地调度器，显示已确认、已预留和未确认用量。供应商账户剩余额度目前无统一数据源。

会话中台使用 Host 的只读管理接口，运行期间自动刷新。跨会话运行分析和独立质量评估仍由 [Zlo Observatory](23-observatory.md) 提供。页面组织参考 [Mu 工作区导航](https://github.com/qybaihe/mu) 和 [Codex 会话权限控件](https://learn.chatgpt.com/docs/permission-modes?site_variant=chatgpt&translationFallback=zh-Hans)。

## 进程与协议

`shared/contracts/management.ts` 定义 `window.agentManagement`，`shared/contracts/chatgpt.ts` 定义 `window.agentChatGpt`。现有 `window.agentHost` 及 JSONL v1 信封保持兼容。

| Preload 方法 | Main / Host 处理 |
| --- | --- |
| `snapshot`、`recentDiagnostics` | 读取有界的 Host 管理投影、应用版本和经过验证的诊断文件 |
| `conversationObservatory` | 读取指定会话的聚合计数、模型用量与最近任务预算。响应只包含结构化统计字段 |
| `savePreferences` | Main 对权限放宽进行原生确认，Host 校验模型和保存策略 |
| `setWorkspaceAccess` | Main 校验目录和授权，Host 用预期权限防止并发覆盖 |
| `setProviderKey`、`testProvider`、`removeProviderKey` | Main 负责凭证，Host 用固定 Provider 接口核验并切换 Pi 配置 |
| `deleteMemory`、`reconcile` | Main 校验结构，Host 校验作用域、任务归属和操作证据 |
| `status`、`signIn`、`cancelSignIn`、`signOut` | Main 管理官方 OAuth 与本地凭证，Host 只收到运行所需的短期授权 |

Main 启动专用 Host 子进程，并在 Host 公告 ready 前从安全存储经私有 stdin 载入凭证。API Key、OAuth token 和私有传输命令均不经 Renderer、持久事件或诊断数据。管理命令只在 Main 创建的桌面传输启用。

## 工作台回归验收

Windows 本地通过 Host 125 项、UI 27 项、中台 21 项和 Electron 端到端 3 项。新增 Host 回归覆盖 52 轮、分会话统计、部分定价与重启。桌面测试覆盖累计用量、同会话模型切换、权限撤销、任务导航和原生凭证边界。Windows 打包目录使用自带 Electron 启动 Pi Host，完成私有启动握手、列表查询和正常退出。模型调用使用测试替身，在线账号授权沿用既有流程。
