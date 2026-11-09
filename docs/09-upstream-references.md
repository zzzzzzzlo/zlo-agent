# 09 · 公开参考资料（2026-11-09 核验）

> 以当前官方仓库和产品文档为准。读架构而不是照抄代码。若代码和文档冲突，以当前 checkout 的可运行行为与类型定义为准并记录 ADR。

## Pi（当前官方上游）

- GitHub：<https://github.com/earendil-works/pi>
- SDK：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md>
- 当前 SDK 包：`@earendil-works/pi-coding-agent`（注意旧资料可能仍使用 `@mariozechner/pi-coding-agent`）。
- Durable（**Experimental**）：<https://github.com/earendil-works/pi/blob/main/packages/durable/README.md>；含 `Harness.resume()`、SQLite/JSONL、TaskGraph、子任务、Abort、Usage 等。但 API 不保证稳定，不能无测试直接代替稳定 SDK。
- Telemetry：<https://github.com/earendil-works/pi/blob/main/packages/telemetry/README.md>；提供通用 Span/Metrics 契约，未强制绑定观测后端。
- 安全提醒：Pi 官方 README 明确自身并不提供文件系统/进程/网络/凭据安全隔离；需要独立 Sandbox。

## Codex

- 开源仓库：<https://github.com/openai/codex>
- Agent 协作工具描述：`codex-rs/core/src/tools/handlers/multi_agents_spec.rs`（先确认当前路径）
- Memory 管线：<https://github.com/openai/codex/blob/main/codex-rs/memories/README.md>
- 借鉴：任务分配工具与受控执行分离、Agent Session 生命周期、两阶段记忆提取与整合。不要假设有完全相同的任务 DAG 权威模型。

## DeepSeek Harness (DSH)

- GitHub：<https://github.com/deepseek-ai/deepseek-harness>
- Session：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md>
- Persistence：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md>
- Subagent：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent/README.md>
- Team：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/team/agent-team/README.md>
- 借鉴：append-only Session、flush durable barrier、崩溃时关闭中断 Turn、可继续子 Agent、Team 任务板 CAS、委派深度/并发硬限。

## Claude Code（仅官方公开资料）

- 官方 Hook 说明：<https://claude.com/blog/how-to-configure-hooks>
- 官方实战：<https://support.claude.com/en/articles/14554000-claude-code-power-user-tips>
- 官方协作模式：<https://claude.com/blog/multi-agent-coordination-patterns>
- 借鉴：SessionStart/PreToolUse/PostToolUse/Stop/PreCompact 事件边界、确定性验证、Resume/权限策略；**不使用意外外泄的非授权源码作为依赖，也不复制其内部实现**。

## 腾讯 Hy-Memory（后续 Memory Phase）

- <https://github.com/Tencent-Hunyuan/Hy-Memory>
- 借鉴：区分 Facts 与 Experiences、Coding 修改演化链；首轮不强制引入。
