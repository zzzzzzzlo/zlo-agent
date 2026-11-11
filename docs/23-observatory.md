# Zlo Observatory

Zlo Observatory 是独立运行的本地 Web 中台。它从 Host 的只读端口收集事件和状态快照，把数据保存到自己的 SQLite。浏览器只连接中台。Host 继续通过原有 JSONL 处理执行和控制命令。

## 差距与实施

| 基线 | 缺口 | 实施 |
| --- | --- | --- |
| Host 事件、Task Engine、DAG、AgentRun、Memory 和 Judgment 已可持久化 | 桌面占用 JSONL 通道，独立进程无法连接同一个运行实例 | 在现有 Host 启动路径增加可选回环只读端口，复用事件查询和订阅 |
| 事件已经记录工具回执、Token、预留和核销 | 旧请求缺少统一相关 ID，部分 Context、Memory 和权限事件缺少度量 | 增加兼容的关联和度量字段，保留旧记录的缺测标记 |
| Host 提供任务确定性验收 | 缺少独立 Trace、指标和评估归档 | 建立单独的事件采集和评估存储，评估从受限证据接口读取 |

里程碑依次验证 Host 传输和脱敏、中台回放和指标、评估与浏览器操作。Host、UI 和中台继续分别进行类型检查及回归。Windows CI 运行浏览器、Electron 和打包测试。

## 启动

使用 Node.js 24 及以上版本，在仓库根目录执行。中台运行时只使用 Node 内置模块。Host 依赖仍按原有方式安装。

```powershell
npm.cmd ci --prefix host
$env:ZLO_TELEMETRY_TOKEN = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
Start-Process -FilePath powershell.exe -ArgumentList '-NoExit','-Command','npm.cmd --prefix host run agent -- --fake' -WorkingDirectory (Get-Location).Path
npm.cmd --prefix observatory start
```

打开中台控制台输出的本地链接。浏览器读取片段中的访问令牌后立即清除片段，令牌保存在该标签页的会话存储中。离线演示可向 Host 的 JSONL 窗口提交 [示例任务](../host/README.md)。接入桌面时，在设置了相同 `ZLO_TELEMETRY_TOKEN` 的环境中启动包含本轮代码的 Electron 应用。源码启动依次执行 `npm.cmd ci --prefix ui` 和 `npm.cmd --prefix ui run dev`。用同一端口和凭证连接当前运行的 Host，生产历史随原 Host 数据目录读取。

| 环境变量 | 默认行为 |
| --- | --- |
| `ZLO_TELEMETRY_TOKEN` | 两端共享 32～128 字符的 base64url 值。Host 缺少此值时不监听。 |
| `ZLO_TELEMETRY_PORT` | Host 只读端口 `4557`。 |
| `ZLO_OBSERVATORY_PORT` | 中台端口 `4558`。两端均使用 `127.0.0.1`。 |
| `ZLO_OBSERVATORY_TOKEN` | 每次启动生成独立浏览器令牌。设定时须与 Host 令牌不同。 |
| `ZLO_OBSERVATORY_DATA` | `%LOCALAPPDATA%/ZloAgent/observatory`，没有 `LOCALAPPDATA` 时使用用户主目录。不同 Host 数据源宜分别使用独立目录。 |

只读端口按 Task 游标分批回放。Collector 对活跃任务使用有界的挂起订阅，定期发现新任务并补读。每批事件和消费游标在同一事务提交。重复事件按 ID 和序号核对，序号缺口保留已提交前缀，从最后连续游标重试。Host 离线时页面保留最后一次采集数据并显示连接状态。中台数据库保留完整的脱敏投影和评估记录，当前由本机用户管理留存期。总览适用于本地规模，计算时读取选定任务的历史记录。

## 访问与证据边界

- Host 遥测和中台 API 分别校验 Bearer 令牌、回环 Host 请求头及 Origin。两个监听器均绑定 IPv4 Loopback。Host 端口只提供任务列表、快照、事件、订阅等待和只读评估取证。
- 运行数据通过字段白名单投影。未识别事件保留序号并标记 `telemetry.redacted`。原始目标、会话文本、文件内容、绝对路径、凭证和工具输出留在普通遥测边界之外。
- 评估证据单独按任务或节点请求。读取用户在表单明确选择的至多六个工作区相对文件，最多保留每文件 4000 字符正文与 4000 字符本机暂存及未暂存 Diff 摘录。既有 Workspace 校验拒绝链接逃逸、隐藏敏感文件和非文本文件。节点使用其交付、检查及操作回执约束所选文件。独立 Worktree 节点当前只用其可取得的历史回执和验收结果。
- 评估使用取证时的文件版本。提交后未保留在本地 Diff 的变更、缺失文件和已删除工作区无法按原样恢复。中台保存摘要、证据引用、采集游标和摘要哈希，用于比较重新取证的评估。目标正文、摘录与 Diff 不写入中台数据库。关停或崩溃时中断评估，已经发出的模型调用不会自动重跑。

## 指标与 Trace

首页展示 24 项核心指标，二级页面显示明细和样本覆盖。每项指标的单位、定义、样本数或分母由 `buildMetrics` 的定义和 API 输出提供。时间范围选中 TaskRun 后，任务结果和 DAG 使用完整运行快照，事件及调用指标按时间、角色和模型过滤。

| 领域 | 采集来源与计算 |
| --- | --- |
| Task | `verification.finished.executionStatus` 达到验收阶段的当前尝试 / 选中已结束 Run。失败率为 Host `failed` / 已结束 Run，确定性验收率为 `verified && passed` / 已结束 Run。停止和阻塞单列。 |
| Task DAG | 权威节点和依赖边、计划变更及尝试事件。关键路径按最近结算的节点尝试与显式依赖计算，不把父节点和并行分支叠加。历史依赖不完整、尝试不可配对时保留未知。 |
| Multi-Agent | `agent.started/finished` 配对 AgentRun，节点开始和结算配对委派。峰值按生命周期重叠计算。区间并集给出生命周期覆盖时间，和累计生命周期时间分开。生命周期包含等待，纯计算耗时未知。 |
| Model | 以预留、核销和用量的相关 ID 配对。旧版仅在相邻且同 AgentRun 可以确认时归因。用量拆分输入、输出、缓存读写。耗时为预留到核销，估算成本来自有价格的报告；未覆盖费用和实际账单未知。 |
| Tools | 按持久化操作回执配对开始和结束。失败率使用已结算状态，未知副作用保留独立类别。新工具结算可记录异常、取消、非零退出码或工具报告失败。重复调用按已有回执统计，原始参数不参与推断。 |
| Context | `context.compacted` 记录压缩前后估算 Token；预留记录请求的输入估算、输出与任务上限；Scope Context 的字节数和预算来自召回埋点。压缩成本仅汇总可归因的已定价调用。 |
| Memory | 采集及召回按事件数量、注入数量与观测耗时计算。注入表示进入上下文，实际是否影响决策、单独模型费用未知。 |
| Judgment | 按六个决策点、模式、特征版本聚合。通过相关 ID 查看规则、实际选择、Shadow 结果及结算。分歧率以提供 Shadow 结果的调用为分母。费用只有 Judge 提供估算时可见。 |
| Reliability | Host 结束原因、停止和恢复、回执核对、模型输出恢复、序号缺口及未配对项。连接健康单独显示。 |
| Security | 读取记录的权限变化、批准与拒绝、策略拦截及高风险回执。缺少历史埋点时保留覆盖限制。 |

`measured` 表示当前样本的直接计量，`estimated` 表示来源或计算本身为估算，`unknown` 表示没有完整可确认数据，`not_applicable` 表示样本明确不适用。估算价格与用量覆盖并列，缺失价格不作为零。Trace 时间线按 TaskRun、Attempt、Node、AgentRun、父 AgentRun 和相关 ID 连接原始投影；详情链接可定位单条事件。任务墙钟跨度、模型请求累计时长、模型时间覆盖、Agent 时间覆盖和依赖等待分别计算。

## 独立评估

在「评估」发起 Task 或 Node 评估。默认只读检查证据，显式选择了声明检查的文本文件时会对采集到的版本复核文件条件。自动评估开启后，仅对之后完成的根任务运行确定性评估，每个 TaskRun 尝试最多一次。历史 `verified` 的通过范围仍限于原检查，其他维度显示未知。没有充分证据时保留 `uncertain`。重新评估会重新取证，结果比较会显示证据是否发生变化。

可在中台进程配置 `ZLO_EVAL_PROVIDER`（`openai` 或 `deepseek`）、`ZLO_EVAL_MODEL` 和独立的 `ZLO_EVAL_API_KEY`。用户每次在表单选中文件和授权模型评估后，评估器才会把经处理的必要证据发送到所选供应商。复用 Host 已有测试结果；评估器没有 Shell、任意文件读取和执行工具，也不会启动新的项目测试。

| 预算 | 可配置变量 | 默认 |
| --- | --- | --- |
| 总生成 Token | `ZLO_EVAL_MAX_TOKENS` | 1600，最大 8192 |
| 请求轮次（包含重试） | `ZLO_EVAL_MAX_ROUNDS` | 1，最大 4 |
| 总请求体字节 | `ZLO_EVAL_MAX_INPUT_BYTES` | 24 KiB，最大 96 KiB |
| 总评估模型等待时限 | `ZLO_EVAL_TIMEOUT_MS` | 30 秒，最大 120 秒 |
| 每百万 Token 美元价 | `ZLO_EVAL_INPUT_USD_PER_MILLION`、`ZLO_EVAL_OUTPUT_USD_PER_MILLION` | 未配置时费用未知 |

评估以证据引用约束 `0–5` 三维分数。`0` 为已证明失败，`1` 为严重缺陷，`2` 为明显缺口，`3` 为满足主体要求但有限制，`4` 为仅有少量问题，`5` 为完整证据支持。未知保留空分。结论 `pass`、`fail`、`uncertain` 随规则版本、模型、用量、估算费用、证据引用和发现单独保存。确定性检查的结论与独立 AI 评分在记录中保留来源，两者均不会修改 Host 任务。

## 开发检查

```powershell
npm.cmd --prefix observatory run typecheck
npm.cmd --prefix observatory test
```

中台浏览器端到端测试使用 Windows 上的 Edge。离线模型用例校验两家正式接口的请求、响应和计费数据处理，测试不会产生在线用量。
