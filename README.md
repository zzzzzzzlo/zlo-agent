# Local-first 通用 Agent · 首轮开发包 v0.1

**项目定位**：通用 Agent 架构，首个落地场景为 Windows 本地 Coding Agent。基于 Pi，不改写 Pi Agent Loop。首轮目标是让一个真实、可恢复、可观测的任务执行闭环跑通，而不是一口气实现最终全部模块。

**优先入口**：将本包内容复制进你的项目后，把 `CODEX_START.md` 的内容发送给 Codex；也可让它先读本包根目录的 `AGENTS.md`。

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
| `diagrams/system.mmd` | 可渲染的 Mermaid 系统架构图 |
| `diagrams/runtime-sequence.mmd` | 可渲染的运行与停止流程图 |

## 本轮完成定义

运行本地 Agent Host，能够：创建 Coding 任务；调用 Pi 的真实 Agent Session（有凭证时），在无凭证时用确定性测试替身走通相同契约；持久化任务、会话关联与事件；通过 IPC/RPC/HTTP + SSE 之一查询与流式订阅；接收追加说明和追加任务；执行优雅停止并恢复；至少一个受控子任务委派路径；稳定的编译、单元测试、恢复测试。

**首轮不实现**：全量 Agent Team、跨提供商订阅额度统一结算、Jev 实际在线部署、长期记忆智能提炼、真实沙箱产品化、移动端和跨设备同步、大而全的观测仪表盘。

> 注：接口应预留，但**不可**声称缺失的沙箱或权限能力已经提供了安全保障。高风险工具默认拒绝/受限执行。

## 可运行的首轮 Host

从 [Host 使用手册](host/README.md) 启动 CLI，或查看 [开发里程碑与验收记录](docs/10-sprint-execution.md)。仓库中的 `ui/` 是独立 Electron 原型，当前仍使用它自己的 Mock Adapter。
