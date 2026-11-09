# Pi Agent 接入指南

接口位于 `src/integrations/agent/AgentAdapter.ts`。当前实现是同目录的 `MockAgentAdapter`，由 `src/stores/workspace.ts` 在组装工作区时注入。

| 契约 | 含义 |
| --- | --- |
| `send({ sessionId, runId, messages })` | 接收当前运行标识及可见历史，Promise 表示提交是否被接收 |
| `subscribe(listener)` | 订阅流式事件并返回取消订阅函数 |
| `cancel({ sessionId, runId })` | 请求停止指定运行，重复取消允许安全返回 |
| `steer({ sessionId, runId }, text)` | 为正在运行的任务提交后续指令，首版 Mock 返回未接入错误 |

实现 `PiAgentAdapter` 时，在适配器内把宿主事件归一化为 `message.delta`、`tool.updated`、`run.ended`。文本事件携带新增片段，同一个工具用固定 ID 更新状态。每次接受运行后产生一次终止事件（完成、取消或错误），并始终原样返回会话和运行标识。取消成功后也需要终止事件，界面据此恢复发送按钮。宿主若已经保存会话历史，应在适配器中按会话绑定复用，避免在续聊时重复导入。

引入运行时后，只在 Electron 主进程或独立宿主中管理运行时连接。按实际需要扩展 preload，把 IPC 限制在上述操作和事件。实现适配器后，在工作区组装点替换 Mock，并从适配器能力声明驱动模型、运行中指令和工具入口的可用状态。聊天列、工具卡与窗口组件继续消费标准事件。

验收时优先覆盖切换会话后的迟到事件、同时运行两个会话、用户取消与正常完成的竞争、宿主退出后收束所有运行，以及中文文本的流式边界。
