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
| `diagrams/system.mmd` | 可渲染的 Mermaid 系统架构图 |
| `diagrams/runtime-sequence.mmd` | 可渲染的运行与停止流程图 |

## 当前桌面版

选定工作区后可授权文件写入，验收文件可选。用户明确选择信任项目后，Agent 可运行受控的 Node/npm 命令和本地 Git 检查，并以实际执行结果验收。Activity Panel 展示工具、模型用量和 Team/Worker 进度。

Host 提供版本化 Task DAG、Root/Team/Worker 分层执行、模型预留和用量核销、上下文压缩、证据记忆和规则判断。Pi 保留 Session 与单 Agent Loop。Task 与 Conversation 可重放事件支持中断后核对和恢复。

信任项目的命令按当前系统账户运行。隔离、恢复和模型路由的边界见 [第三轮验收](docs/17-core-verification.md)。旧版桌面协议和实施记录见 [Sprint 4](docs/11-desktop-protocol.md) 与 [Sprint 0–3](docs/10-sprint-execution.md)。
