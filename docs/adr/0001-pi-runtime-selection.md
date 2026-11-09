# ADR 0001 · Pi Runtime 选型

状态：接受，锁定 `1.5.0`。真实在线 Provider 的 Smoke Test 单独验收。

npm 公共注册表及 Pi 官方发布页均显示普通 Coding SDK 与 Durable 为 `1.5.0`，Node 最低版本为 `22.19.0`。Host 使用本机 Node 24 与内置 SQLite。以已发布版本的类型和源码作为适配依据。

采用 `@earendil-works/pi-coding-agent`。`createAgentSession`、`SessionManager`、自定义工具、事件订阅、`abort`、`steer`、`setModel` 和 JSONL 历史来自 Pi。适配器等待 prompt 收敛后判断本轮结果，因为 SDK 调用可能以错误消息结束。工具授权与回执在工具实现边界完成。

Durable 是独立实验性 Harness。它提供可重启 Task Graph、请求去重、持久存储、Abort 和工具 replay policy。显式安全重放仍要求操作自身具备幂等性。迁移需要替换 Coding Session 和资源、工具集成，并重新划定业务 DAG、验收与状态权威。首轮保持 Task Engine 为任务权威，Pi 管 Session，避免并行写入两套任务生命周期。

SQLite 与 Pi JSONL 是两个持久化边界。停止意图、Task 状态、工具回执及对应事件在 SQLite 事务中提交。停止等活动运行完成、Session 刷盘和资源释放后提交终态。崩溃后保留持久化历史，未确认写入由人工核对。工作区只提供范围受限的文本操作，默认不注册 Shell 或用户目录里的扩展、技能与配置。

借鉴 Codex 分离中断应答与终态、DSH 独占写者和显式 flush、Claude Code 的 Worker 独立上下文与 Hook 验收边界。任务验收仍由本地确定性检查器负责。

- [Pi v1.5.0](https://github.com/earendil-works/pi/releases/tag/v1.5.0)
- [Coding SDK](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/sdk.md)
- [Durable](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/README.md)
- [Codex 中断实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/mod.rs#L1006-L1128)
- [DSH 持久化](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md)
- [Claude Code 子 Agent](https://code.claude.com/docs/en/sub-agents)
