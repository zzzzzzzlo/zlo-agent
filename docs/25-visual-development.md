# 本地视觉开发闭环

在有 Workspace 写入权限的会话中，提交 HTML 页面或 SVG 动画开发任务。普通静态页面进入快速模式，动画默认进入高质量模式。任务说明可以显式指定「快速模式」「高质量模式」或「不要预览」。模型视觉能力来自当前 Pi 模型目录。DeepSeek V4.1 Flash 对应 `deepseek/deepseek-flash`，支持原生图片输入。[DeepSeek Vision](https://api-docs.deepseek.com/guides/vision/)

## 本地预览

`preview_page` 是独立的 Root 只读工具，可在授权工作区内调用。下面的调用在三个时间点渲染同一个入口。

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

## 图像、轮次和预算

| 模式 | 预览调用上限 | 单次帧数 | 反馈阶段墙钟和 Token 预算 |
| --- | ---: | ---: | --- |
| 快速 | 2，包含初稿 | 1 | 每次运行 75 秒，任务累计 64,000 Token |
| 高质量 | 3，包含初稿 | 3 | 每次运行 150 秒，任务累计 192,000 Token |

Pi 的工具适配器为有视觉能力的模型构造 `image` 内容块。JPEG 每帧最多 160 KiB，每次模型请求最多三帧，预留每帧 2048 Token。图片只进入下一次请求，历史会话仅保存工具状态与诊断。文字模型收到 `unavailable_on_selected_model` 和结构诊断。视觉任务文本预留使用已报告的输入用量和本地估算，已核销的请求按供应商实际用量计入反馈预算，未确认用量仍占用原预留。[Pi Agent SDK](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)

视觉工作流要求先渲染再检查主体、比例、配色、遮挡、溢出和动作连续性，发现问题做定向编辑后复验。静态页与简单动作使用适当的简单技术，涉及自然踏板动作时可使用联动关键帧或关节连杆。高质量任务若已经改动可识别的 HTML 产物但忘记渲染，视觉模型可收到一次有界的预览提示。无可见缺陷时可以在首次预览后结束。最后一次成功预览用于验收，缩小模型输出预留并结束该任务的视觉文件编辑轮次。

## 运行证据

Trace 复用原有 TaskRun 和 AgentRun 事件。`visual.draft_ready` 记录首次确认写入 HTML 的耗时。`visual.preview_finished` 记录渲染耗时、采样数和异常数。`visual.frames_sent` 记录进入请求的帧数和估算 Token。`visual.round_finished` 汇总一次反馈阶段实际报告的 Token 和修改状态，缺报时保留覆盖标记。`visual.loop_finished` 记录本次执行的视觉阶段结果。任务总墙钟来自 Task Trace。需要独立质量结论时，在既有中台 Evaluation 页对同一任务和选定产物发起评估，分数和证据仍按原有独立流程保存。

## 实测复现

使用同一份 `deepseek-flash` 授权，安装 Node 24 和两个提交相同的锁定依赖。将旧版 `b1ad4e3` 放在独立工作树后，从新版仓库运行比较脚本。

```powershell
node --disable-warning=ExperimentalWarning host/scripts/visual-benchmark.ts <旧版工作树> .zlo-agent/visual-benchmark
```

将 `DEEPSEEK_API_KEY` 从本机凭证安全传入该进程。脚本使用隔离工作区，以相同任务和外层预算比较鹈鹕、鳄鱼两个场景，输出真实 Provider 用量、耗时及供独立查看的三帧截图。设置 `ZLO_VISUAL_BENCH_SEEDED=1` 使用内置遮挡夹具，`ZLO_VISUAL_BENCH_TOKENS` 可调整每组相同的外层预算。测试产物位于 Git 忽略目录。
