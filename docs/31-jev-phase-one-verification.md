# Jev Phase 1 验收记录

工作基线为 `frontend-rebuild` 的 `8e0a0e8`。本轮复用已有六处 Judgment 调用及 Rule Baseline。新增内容包括 System One 适配器、Host 配置与预算、桌面凭证和模式管理，以及 Observatory 的判定证据投影。参考 [MU 的 TypeSafe Adapter](https://github.com/qybaihe/mu/blob/main/packages/kyrn-judge/src/providers/typesafe.ts) 和 [System One API](https://docs.typesafe.ai/api/system-one)。

| 验收 | 结果 |
| --- | --- |
| Host、UI 与 Observatory 类型检查 | 通过 |
| 真实 Host DAG 和六处 Judgment 调用 | 通过。使用模拟 System One HTTP 响应，核对六处语义输入、Shadow 保持规则选择、版本回传和事件关联 |
| Judgment、Memory 及依赖边界定向回归 | 10 项通过。覆盖 Active 合法候选、凭证删除、脱敏、超时、离线、认证失败、限流、响应非法和预算 |
| UI 回归 | 27 项通过 |
| Observatory | 全套 22 项通过，含 Jev 用量与费用分母回归 |
| Host 全套 | 141 项通过 |
| Windows Electron | 构建通过；按用户要求停止会弹出窗口的 E2E。新增桌面回归覆盖六点开关、重启恢复及凭证隔离，待完整运行 |
| GitHub Windows CI | 当前工作流由 main 推送或 Pull Request 触发 |
| TypeSafe 真实 API | 未验证。当前开发环境未提供 Jev API Key。可按 [接入文档](15-jev-integration.md) 在桌面完成冒烟 |
