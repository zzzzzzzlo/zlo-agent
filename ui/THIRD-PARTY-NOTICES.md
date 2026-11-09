# 许可与第三方组件

Zlo Agent 的原创代码和图形采用 [MIT](LICENSE)。[PI-Desktop](https://github.com/vastsa/PI-Desktop)（LGPL-3.0）用于布局与交互参考，项目代码和标识为独立实现。

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| [Liqui Design](https://github.com/leefanv/liqui-design) | MIT，Copyright (c) 2026 Fan Li | 官方玻璃组件与折射内核 |
| [Electron](https://github.com/electron/electron) | MIT，附 Chromium 和其它第三方许可 | 桌面窗口与渲染引擎 |
| [React / React DOM](https://github.com/facebook/react) | MIT | 渲染器 |
| [Zustand](https://github.com/pmndrs/zustand) | MIT | 界面状态 |
| [Lucide](https://github.com/lucide-icons/lucide) | ISC，部分 Feather 图标为 MIT | 图标 |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | MIT | 样式构建 |
| [Vite](https://github.com/vitejs/vite)、[electron-vite](https://github.com/alex8088/electron-vite)、[electron-builder](https://github.com/electron-userland/electron-builder) | MIT | 构建、开发与打包 |
| [Pi Coding Agent](https://github.com/earendil-works/pi) | MIT | 随桌面程序分发的 Host 运行时，许可证随各 npm 包保留 |
| [Playwright](https://github.com/microsoft/playwright) | Apache-2.0 | 开发和桌面集成测试 |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | 类型检查 |

锁定版本见 `package-lock.json`。随客户端一起分发的渲染器依赖许可见 `licenses/`。Electron 分发目录包含其许可和 Chromium 第三方许可。
