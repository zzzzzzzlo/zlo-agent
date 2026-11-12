# Harness 与能力委派

开发基线为 `567f463`。基线已接入 Pi 会话、DAG、Workspace 网关和截图工具，但工具发现依赖任务文本，预览达到固定次数后会约束文件修改，部分通用工具按 Agent 角色隐藏。本轮保持 Pi 会话和 Agent Loop，调整工具、指令、授权及预算在 Host 中的接入方式。

## 上游与本地实现

| 参考机制 | 本地接入 |
| --- | --- |
| Pi Coding Agent SDK 的 Session、ResourceLoader、工具执行模式和上下文压缩 | 复用 `createAgentSession`、Pi 默认 Coding System Prompt 和 Compaction。可信 Host 组装资源，`executionMode: sequential` 让同一 Run 按顺序执行工具调用。独立 DAG 节点仍由 Task Engine 调度。 [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/sdk.ts) |
| DSH 对 Prompt 各来源和工具生命周期的区分 | Host 工作约束、项目指令、已有 Memory 与用户目标保留各自的来源。工具通过现有的执行前审批、回执、取消、清理和结果封装。 [DSH Prompt Assembly](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/src/index.ts) |
| Codex `view_image` 的主动读取与多模态结果 | `view_image` 读取授权工作区的图片，`browser_screenshot` 截取当前视口。两者复用本地浏览器和 Pi 图像通道。 [Codex view_image](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/view_image.rs) |

## 工具、指令与信任

- 本地 `browser_open` 和 `preview_page` 使用受控页面快照和显式资源清单。独立浏览器上下文没有用户的登录态。公共页面使用原有 HTTPS 请求校验和审批。模型在工具可用时直接选择浏览器、预览或图片检查。保存截图须通过文件路径和写权限检查。
- 图像只进入工具返回后的下一次可用模型请求。JPEG 大小、分辨率、单次请求的帧数和估算 Token 有硬限制。文字模型收到尺寸、状态或渲染诊断，并标明视觉输入不可用。
- Host 数据目录下的 `instructions/AGENTS.md` 与 `instructions/skills/<name>/SKILL.md` 属于用户指令。授权为 Trusted 且未限定子路径时，还可发现 Workspace 根的 `AGENTS.md`、`.pi/skills` 和 `.agents/skills`。项目中同名 Skill 优先。发现时只加载说明，`read_skill` 按名称读取已登记的 Markdown，并再次校验文件身份、内容版本和授权。链接、超限资源、外部路径与可执行扩展不在加载范围内。更改指令或 Skill 后，开启新 Run 刷新。
- 文件内容、网页、图片和命令输出是任务数据。写入、Patch、删除、Shell、Git 和浏览器操作均经过 Capability Gateway。工具回执记录各自的结果，最终验收仍由 Task Engine 按交付证据处理。

## 委派

Root 使用 `delegate_task` 或 `propose_task_plan`，Team 可用 `delegate_worker` 继续委派。委派可提供目标、文件验收条件、相对路径、`access`、明确的 `tools` 清单和 `budget`。未指定 `access` 时保持只读。Shell、浏览器、Web、Git 和导出等能力需在子节点明确列出，对应权限、用户审批及资源约束仍生效。Workspace 范围、访问级别、工具和预算均可收窄。管理 Task、Worktree 分配与权限提升的入口仍由可信 Host 控制。

下面的委派允许 Worker 编辑 `src/`，最多发起四次模型请求。

```json
{
  "goal": "为 src/report.ts 添加输入校验并检查生成文件",
  "access": "write",
  "scopePath": "src",
  "tools": ["read_text_file", "edit_text_file"],
  "budget": { "requests": 4, "tokens": 60000, "timeMs": 120000 },
  "check": { "path": "src/report.ts", "contains": "validateInput" }
}
```

同一工作区内的独立只读节点可以并行。有冲突的写入串行，或使用已登记的独立 Git Worktree。Team 等待嵌套 Worker 时暂停自身工具操作。恢复时会复用相同目标和授权的节点。Shell 和浏览器资源只由创建它的 AgentRun 持有，结束后释放。Shell 的 Trusted 授权与 Worktree 不构成系统沙箱。副作用结果未知时继续使用现有 `needs_reconciliation` 流程。

## 运行模式与用量

| 配置 | 默认值与效果 |
| --- | --- |
| `ZLO_AGENT_HARNESS_MODE` | `quality` 使用 Pi 默认推理策略，Root 15 分钟、子节点 5 分钟。`fast` 请求低推理强度，Root 10 分钟、子节点 2 分钟。父 Run 可提前取消子节点，节点也可申请更短的 `timeMs`。 |
| `ZLO_AGENT_TASK_TOKEN_LIMIT` | 默认每任务 2,000,000 Token。可在 Host 启动环境调整。 |
| `ZLO_AGENT_TASK_REQUEST_LIMIT` | 默认每任务 96 次请求。可在 Host 启动环境调整。 |

输出上限由 Pi 模型目录和剩余额度共同决定。支持限制输出的 Provider 使用 Host 实际批准的 `maxTokens`。ChatGPT 账号路由按其模型上限预留。重试和压缩各自占用预算。已确认的 Token 按实际用量结算，缺报的预留在重启后继续按不确定用量记账。中台可从 `agent.started` 与 `model.reserved`、`model.reservation_settled` 读取策略、预算和核销结果。配置随 Host 启动生效。

## 复现真实视觉对照

将 `567f463` 放入独立工作区并安装同一份锁定依赖。用本地授权的 DeepSeek API Key 作为进程环境变量运行现有对照脚本。下面的设置让两版使用相同的遮挡初稿和外层预算。为避免浏览器启动并发影响观察，分别运行两个场景。

```powershell
$env:ZLO_VISUAL_BENCH_SEEDED = '1'
$env:ZLO_VISUAL_BENCH_TOKENS = '160000'
node host/scripts/visual-benchmark.ts <基线目录> .zlo-agent/harness-check/visual pelican
node host/scripts/visual-benchmark.ts <基线目录> .zlo-agent/harness-check/visual crocodile
```

脚本记录 Provider 报告的 Token、请求、运行耗时、实际送图与独立复查结果。单个样本受缓存命中、Provider 响应和模型决策影响，应与自动化回归分开解读。
