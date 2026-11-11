# Zlo Observatory 验收记录

基线为 `599d22e`。本轮依次接通可选 Host 只读传输、独立采集和评估存储、Trace 和 24 项首页指标、七页 Web Dashboard 及 Windows CI。使用、指标分母和证据边界见 [中台说明](23-observatory.md)。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| `npm.cmd --prefix host run typecheck` 和 `npm.cmd --prefix host test` | 类型通过，118/118 通过 |
| `npm.cmd --prefix ui run typecheck` 和 `npm.cmd --prefix ui test` | 类型通过，27/27 通过 |
| `npm.cmd --prefix ui run test:desktop` | Windows Electron 3/3 通过 |
| `npm.cmd --prefix observatory run typecheck` 和 `npm.cmd --prefix observatory test` | 类型通过，21/21 通过，包含 Windows Edge E2E |

- 采集从真实 Host CLI 启动并执行本地任务，覆盖订阅、断开后续读、重复、缺口回滚及补齐、Host 离线与重启。验证 Worker 取证范围、Cookie 和密钥形态脱敏，选中文件被修改或移除时保留历史验收并单独报告当前证据。
- Trace 覆盖并发区间并集与累计时间、DAG 关键路径、请求及回执配对、模型用量和估算成本、Memory 与 Judgment 归因，以及缺测处理。
- 独立评估覆盖三种结论、虚构引用、确定性复核、模型请求体、预算与重试、超时和取消、重启中断、费用隔离、自动评估和不可变证据摘要。远程模型响应使用测试替身。
- 浏览器验证七页导航、任务筛选、精确事件跳转、评估提交与比较、自动开关持久化、Host 离线后的历史访问和窄屏布局。

## 已知范围

当前只收集被授权的本机 Host，价格为估算。历史未埋点字段、纯计算时间、实际账单和 Memory 对推理结果的影响保留未知。选中文本以取证时的版本为准，已提交且当前 Git Diff 中不可见的历史变更无法按原样重建。模型评估需要独立凭证和逐次授权，未使用付费 API 做在线验收。没有部署 Jev 或自动化实验调度。

WorkBuddy 复核了并发区间、请求配对、覆盖分母与部分成本，也给出了供应商诊断脱敏的回归案例。模块实现分别经过本地类型检查、集成与浏览器测试。
