# 第三轮 · 核心能力差距与实施计划

基线为 `fc9a271`。总体设计沿用 01–07，Sprint 0–4 与修复报告保留为历史记录。

| 状态 | 模块 | 第三轮工作 |
| --- | --- | --- |
| 已完成 | Pi Runtime、桌面/JSONL、Conversation 与增量事件、SQLite、基础停止恢复 | 复用 SDK Session 和现有检查点；保留协议与历史记录兼容性。 |
| 部分实现 | 文件工具、权限、验收 | 分离工作区授权与验收，扩展真实文件/Git/项目命令。为执行项目代码设置单独授权，工具侧检查作用域。 |
| 部分实现 | Task Engine、Orchestrator | 扩展单 Worker 叶为有版本的 DAG。保留单叶接口兼容，加入就绪调度、重规划、独立的 Team 身份和工作交付。 |
| 部分实现 | Model Scheduler、Context Builder、Judgment | 从路由/上下文/规则基线扩展为可用模型目录、预留和用量、受预算上下文、六个真实决策入口。 |
| 尚未实现 | 长期记忆、Plugin/Profile/Workflow | 独立作用域记忆及来源，扩展注册和能力声明，落地 Coding 工作流。 |
| 范围外 | Jev 在线部署、完整观测中台、系统级沙箱产品化 | 提供结构化判断替换入口、数据契约和诚实的隔离边界。 |

## 实施与验收

1. 冻结共享的工作区授权、命令验收、DAG 节点和可替换决策接口。并行实现 Workspace、Task Engine 和 Memory/Judgment 子模块。
2. 接入工作区能力、动态 DAG 和分层运行。验收实际文件/项目命令、路径与授权、依赖与并发、Team Session 续用、停止与未知副作用。
3. 接入模型资源、上下文、记忆、扩展及六个决策点。验收无凭证及跨 Provider 隔离、配额收敛、决策模式、记忆来源和脱敏事件。
4. 打通 Electron 工作区授权与运行证据。运行原有与新增 Host/UI 测试、Electron E2E、Windows 构建与随包 Host 启动检查，交付接入契约和验收报告。

根任务和全部 DAG 节点的状态由 Task Engine 管理，Agent 身份与 Session 由 Orchestrator 管理。使用同一工作树时保守串行化写访问，受信任命令按当前 Windows 用户权限执行。Pi 继续负责单个 Session 的 Agent Loop。
