# 首轮执行记录

开发根目录采用现有 Electron UI 所在的工作区。外部材料目录作为设计来源。Host 与 UI 使用独立包，CLI 先覆盖完整执行协议，桌面端可继续通过自己的 Adapter 接入。

| 阶段 | 依赖与实现 | 验收 |
| --- | --- | --- |
| Sprint 0 | 核实 Pi 包及 Durable，冻结运行时 Port，搭建 TypeScript 和 SDK 探针 | 本地可创建 Pi Session、调用受控工具、收事件、停止、重开、换模型。离线替代流不计作在线 Smoke Test |
| Sprint 1 | SQLite / Event Store → Task Engine → Host Command 与 CLI | 重复请求、持久状态与 Session、游标回放、观察者隔离、确定性验收及重启历史 |
| Sprint 2 | Stop/Recovery → Orchestrator / Worker → 能力授权与操作回执 | 停止状态可解释，未确认写入阻塞，Fresh Worker 的完成、失败、预算、释放和恢复 |
| Sprint 3 | 固定模型路由与切换，Memory/Judgment/Sandbox ports，交付说明 | 已授权路由才可启用，保留 Run/Session 关联，记录实际测试与手工 Smoke 步骤 |

首轮单进程只执行一个根任务。每个根任务最多一个只读 Worker。工作区写入限于受控文本工具，验收使用用户指定的文件检查。模型切换和用户指令在安全轮次边界应用。SQLite 不自动重放写入。
