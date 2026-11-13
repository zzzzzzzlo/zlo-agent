# Zlo Agent · Local-first 桌面 Coding Agent

Zlo Agent 是基于 Pi 的本地优先通用 Agent，首个场景为 Windows Coding。Electron 和 Host 分离，Task Engine 统一管理持久化任务状态。

从 [桌面启动](ui/README.md) 或 [Host CLI](host/README.md) 开始。开发约束在 [AGENTS.md](AGENTS.md)，实施记录按轮次保存。

## 文件索引

| 文件 | 作用 |
|---|---|
| `CODEX_START.md` | 交给 Codex 的主执行提示词 |
| `AGENTS.md` | 开发代理必须遵守的项目约束 |
| `docs/01-product-and-decisions.md` | 已明确需求、暂缓项和架构原则 |
| `docs/02-architecture.md` | 整体模块图、依赖边界、数据归属 |
| `docs/03-contracts.md` | 核心 TypeScript 契约草案与运行语义 |
| `docs/04-runtime-and-recovery.md` | 执行、追加任务、优雅停止、恢复、异常治理 |
| `docs/05-agent-collaboration.md` | Supervisor + Team + 临时 Worker 与收敛治理 |
| `docs/06-memory-jev-model.md` | Memory、Decision/Jev、模型路由预留接口 |
| `docs/07-security-and-observability.md` | 权限、Sandbox 接口、中台事件、脱敏 |
| `docs/08-implementation-plan.md` | 首轮实施顺序、测试与验收清单 |
| `docs/09-upstream-references.md` | 源码和官方文档参考及核验原则 |
| `docs/14-core-development.md` | 第三轮差距与实施顺序 |
| `docs/15-jev-integration.md` | Jev 与六个判断点接入 |
| `docs/16-observability-contract.md` | 中台事件与证据契约 |
| `docs/17-core-verification.md` | 第三轮交付与验收 |
| `docs/18-tool-system.md` | 工具清单、授权、回执与实际隔离边界 |
| `docs/20-desktop-management-plan.md` | 0.5.0 桌面管理差距与里程碑 |
| `docs/21-desktop-management.md` | 0.5.0 设置、协议、权限与核对说明 |
| `docs/22-desktop-0.5.0-verification.md` | 0.5.0 验收结果与剩余限制 |
| `docs/23-observatory.md` | 独立中台启动、指标定义和评估边界 |
| `docs/24-observatory-verification.md` | 中台验收、测试和已知范围 |
| `docs/25-visual-development.md` | 本地页面预览、视觉反馈与运行预算 |
| `docs/26-visual-verification.md` | 鹈鹕和鳄鱼的回归及同模型实测对照 |
| `docs/27-harness-alignment.md` | Pi Coding Harness、能力委派及运行策略 |
| `docs/28-harness-verification.md` | Harness 回归和真实模型运行记录 |
| `docs/29-frontend-backend-handoff.md` | 前端重构对接、桌面接口和后端能力清单 |
| `docs/30-desktop-redesign-brief.md` | 全新桌面 UI 的设计任务书和验收标准 |
| `diagrams/system.mmd` | 可渲染的 Mermaid 系统架构图 |
| `diagrams/runtime-sequence.mmd` | 可渲染的运行与停止流程图 |

## 当前桌面版

从左侧工作台打开 API 接入、权限、任务、工具、记忆和诊断页面。对话顶部可调整会话模型和工作区权限，也可以打开「中台」查看该会话的累计用量、预算和工具调用。Provider 凭证通过系统安全存储保存。任务详情分别显示执行状态与验收结论，开发目标只有在确定性检查通过时才显示已验收。使用和接口见 [桌面管理](docs/21-desktop-management.md)。

选定工作区后可授权文件写入，验收文件可选。用户明确选择信任项目后，Agent 可运行受控的 Node/npm 命令和本地 Git 检查，并以实际执行结果验收。Activity Panel 展示工具、模型用量和 Team/Worker 进度。

Host 提供版本化 Task DAG、Root/Team/Worker 分层执行、模型预留和用量核销、上下文压缩、证据记忆和规则判断。Pi 保留 Session 与单 Agent Loop。Task 与 Conversation 可重放事件支持中断后核对和恢复。

工具扩展加入受控 Shell/Process、文件搜索与精确 Patch、本地 Git 修改与 Worktree、公共网页抓取与搜索、隔离浏览器及原生文件导出。高风险工具通过桌面原生确认，每次授权限定在本次参数和执行。详见 [工具系统](docs/18-tool-system.md)。

信任项目的命令按当前系统账户运行。隔离、恢复和模型路由的边界见 [第三轮验收](docs/17-core-verification.md)。旧版桌面协议和实施记录见 [Sprint 4](docs/11-desktop-protocol.md) 与 [Sprint 0–3](docs/10-sprint-execution.md)。

## 独立运行中台

Zlo Observatory 提供运行指标、Task DAG 和 Agent Trace，以及单独归档的只读质量评估。启动方式和指标定义见 [中台使用文档](docs/23-observatory.md)。
