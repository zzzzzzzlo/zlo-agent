# 本地视觉开发闭环

在有 Workspace 写入权限的会话中提交 HTML 页面或 SVG 动画任务。模型根据任务、授权和工具说明选择渲染、截图和复验。模型视觉能力来自 Pi 模型目录。DeepSeek V4.1 Flash 对应 `deepseek/deepseek-flash`，支持原生图片输入。[DeepSeek Vision](https://api-docs.deepseek.com/guides/vision/)

## 本地预览

`preview_page` 可在授权工作区内只读渲染页面。`browser_open` 使用同一套本地资源校验，提供可继续检查的浏览器会话。`browser_screenshot` 和 `view_image` 能把图片传给视觉模型。下面的预览在三个时间点渲染同一个入口。

```json
{
  "path": "index.html",
  "assets": ["style.css", "animate.js", "rider.svg"],
  "width": 800,
  "height": 600,
  "timesMs": [0, 450, 900]
}
```

- 预览使用新的 Chromium 沙箱进程和浏览器上下文。页面通过 Playwright 路由从有界、只读的工作区快照加载。入口和依赖必须提供精确的相对路径。`file:`、链接逃逸、隐藏敏感文件、未列出的资源、外网、WebSocket、Worker、表单和下载被限制。浏览器没有用户已有的登录态。公共网页浏览工具沿用原有静态渲染和网络授权。
- 入口支持 HTML，样式、脚本、字体和图片可以内嵌或从列表加载。工作区按现有规则校验每个文件，最多显式指定 16 个资源，总体上限 2 MiB。预览视口为 240×160 至 1280×900，时间点为 0 至 4000 ms。单次浏览器预览限时 12 秒。
- 使用 Playwright 虚拟时钟推进 JavaScript 定时器及动画帧。CSS、Web Animations 和内嵌 SVG 动画按采样位置定位。异步创建且依赖真实时钟的复杂 CSS 时间线及外部 SVG 图像内的时间线只能近似采样。每帧记录布局溢出指标，浏览器异常只回传类别和计数，控制台正文留在预览边界内。[Playwright Clock](https://playwright.dev/docs/clock)

## 图像与预算

Pi 的工具适配器为有视觉能力的模型构造 `image` 内容块。JPEG 每帧最多 160 KiB，每次模型请求最多三帧，预留每帧 2048 Token。图片只进入下一次请求，历史会话保存工具状态与诊断。文字模型收到 `unavailable_on_selected_model` 和结构诊断。图像和文字一起使用任务和委派预算，未确认用量仍占用原预留。[Pi Agent SDK](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)

视觉工作可按渲染、检查、定向编辑和复验推进。可检查主体、比例、配色、遮挡、溢出和动作连续性。模型可在满足目标时提前结束，也可在预算内继续验证。运行模式和资源上限见 [Harness 与能力委派](27-harness-alignment.md)。

## 运行证据

Trace 复用原有 TaskRun 和 AgentRun 事件。`visual.draft_ready` 记录首次确认写入 HTML 的耗时。`visual.preview_finished` 记录渲染耗时、采样数和异常数。`visual.frames_sent` 记录进入请求的帧数和估算 Token。`visual.round_finished` 汇总一次反馈阶段实际报告的 Token 和修改状态，缺报时保留覆盖标记。`visual.loop_finished` 记录本次执行的视觉阶段结果。任务总墙钟来自 Task Trace。需要独立质量结论时，在既有中台 Evaluation 页对同一任务和选定产物发起评估，分数和证据仍按原有独立流程保存。

## 实测复现

使用同一份 `deepseek-flash` 授权，安装 Node 24 和两个提交相同的锁定依赖。将旧版 `b1ad4e3` 放在独立工作树后，从新版仓库运行比较脚本。

```powershell
node --disable-warning=ExperimentalWarning host/scripts/visual-benchmark.ts <旧版工作树> .zlo-agent/visual-benchmark
```

将 `DEEPSEEK_API_KEY` 从本机凭证安全传入该进程。脚本使用隔离工作区，以相同任务和外层预算比较鹈鹕、鳄鱼两个场景，输出真实 Provider 用量、耗时及供独立查看的三帧截图。设置 `ZLO_VISUAL_BENCH_SEEDED=1` 使用内置遮挡夹具，`ZLO_VISUAL_BENCH_TOKENS` 可调整每组相同的外层预算。测试产物位于 Git 忽略目录。
