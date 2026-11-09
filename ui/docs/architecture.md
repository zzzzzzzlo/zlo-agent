# 客户端架构

## 窗口与渲染器

- `electron/main` 创建无边框 Windows 窗口，最小尺寸 680 × 520 DIP。拖动由标题栏的 CSS 区域交给 Windows。交互按钮从拖动区域中排除。最大化时，界面的外缘随窗口贴齐屏幕。
- Windows 11 22H2 及以上使用 DWM 圆角和 Desktop Acrylic，模糊后方桌面和其它窗口。较早的 Windows 使用逐像素透明背板和渲染器圆角。系统减少透明度时，界面采用实色背板。 [Electron 窗口材质文档](https://www.electronjs.org/docs/latest/api/browser-window#winsetbackgroundmaterialmaterial-windows)
- `electron/preload` 使用 `contextBridge` 暴露窗口操作和最大化状态订阅。主进程校验调用窗口和主框架来源。渲染器使用 context isolation 与 sandbox，权限请求默认拒绝，生产 CSP 限制脚本与网络连接。
- `src/components/layout` 组合标题栏、可折叠左侧导航和活动面板。小窗口中的活动面板浮在聊天列右侧。
- `src/components/chat` 在欢迎页和消息流之间切换，底部输入框保持独立。消息区接近底部时才跟随流式内容。历史消息按轮次拆分，工具详情按需展开。

## 状态和数据流

```text
React UI → Zustand actions → AgentAdapter → MockAgentAdapter
React UI ← Zustand state   ← AgentEvent   ← MockAgentAdapter
```

`src/stores/workspace.ts` 管理会话、每会话草稿、活动会话和外观。持久层使用带版本键的 localStorage，保存会话和外观；每轮开始与结束时写入，流式增量在内存中合并。再次打开时，上次未结束的运行显示为已取消。草稿和活动面板开关属于当前窗口。

每条消息增量、工具更新和结束事件带 `sessionId` 与 `runId`。切换会话仍能保留原会话的运行状态。删除会话时先移除本地状态，再取消该会话的活动运行，迟到事件会被忽略。Tool 卡片和活动栏读取同一份数据。

## Liqui Design

使用官方 npm 内核 `@liqui-design/glass` 0.5.0，组件壳和交互由本项目实现。通过 `@liqui-design/glass/tokens.css` 加载上游 Design Tokens，`src/styles/tokens.css` 集中管理应用色板、边缘、间距和圆角。

| 官方组件 | 用处 |
| --- | --- |
| `LiquiThemeProvider` | 依据设置统一提供玻璃材质、折射强度、光泽和模糊比例 |
| `LiquiGlass` | 输入坞、欢迎徽记、模型控件、会话菜单、设置弹窗、提示浮层，以及磨砂侧栏 |
| `LiquiGlass` 的自动兼容层 | Chromium 使用官方 canvas 位移贴图与 SVG 滤镜，其他受支持的浏览器走 CSS 模糊 |

柔和档使用磨砂并压低桌面内容，均衡和通透档自动启用折射并提高窗口背板透明度。侧栏与活动栏固定为磨砂，正文与历史行用轻量颜色。应用禁用色散，避免为连续滚动的列表分配位移滤镜。Windows DWM 负责桌面透景与模糊，Liqui 处理窗口内部的折射与玻璃高光。
