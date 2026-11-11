# 0.5.0 桌面管理实施计划

基线为 GitHub main 的 `a0ab153`。Host 仍负责执行和业务状态，Electron Main 负责原生交互与凭证，Renderer 只消费共享 DTO。

| Host 能力 | 桌面协议 | Electron IPC | UI 缺口 |
| --- | --- | --- | --- |
| Task 状态机、检查、工具回执 | 已有 Turn 状态，验收语义需要独立字段 | 沿用 Conversation 事件 | 显示执行与验收两个结论 |
| Pi 模型目录、授权、选路和预算 | 有会话切换，缺 Provider 和偏好管理 | Main 接收原生凭证并通过私有管道同步 | Provider、目录、默认策略、用量 |
| Capability Gateway、权限范围与审批 | 创建时可选择权限，缺既有会话修改和审计视图 | 原生确认权限提升 | 会话授权、工具策略和记录 |
| Task DAG、Agent Tree、运行和产物记录 | 现有事件仅含部分节点摘要 | 增加只读管理投影 | 节点依赖、Agent 关系和交付状态 |
| Memory、检索记录、诊断、未知副作用 | 缺管理 DTO 和核对命令 | Main 读取结构化日志，Host 负责核对与删除 | 作用域内记忆、错误和操作证据 |
| 六个 Judgment 决策点 | 保留现有事件订阅，补充离线实验字段 | 不增加特权 Renderer 通道 | 管理界面只显示任务证据 |

1. 区分执行和验收，补充 Root、Team、Worker、旧历史及恢复回归测试。
2. 接通模型管理与凭证安全存储，验证错误、撤销、Host 重启及真实 Provider。账号登录单独核实官方注册、授权和调用限制。
3. 接通权限、任务、记忆、工具、日志和核对。未知操作只有在独立验证器证明后置条件时才能解除阻塞。
4. 接入设置中心及版本信息，运行 Host、Renderer、Windows Electron E2E 和打包，建立 GitHub Actions。
