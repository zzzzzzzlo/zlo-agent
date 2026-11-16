import { resolve } from 'node:path'
import tailwind from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: { build: { lib: { entry: resolve('electron/main/index.ts') } } },
  preload: { build: { lib: { entry: resolve('electron/preload/index.ts') } } },
  renderer: {
    root: 'src',
    base: './',
    build: { rollupOptions: { input: resolve('src/index.html') } },
    plugins: [
      react(),
      tailwind(),
      {
        name: 'production-csp',
        apply: 'build',
        transformIndexHtml(html) {
          const devScriptCsp = "script-src 'self' 'unsafe-inline'"
          const devConnectCsp = "connect-src 'self' ws://localhost:* ws://127.0.0.1:*"
          if (!html.includes(devScriptCsp) || !html.includes(devConnectCsp)) {
            throw new Error('Expected development CSP directives in src/index.html before production replacement')
          }
          return html.replace(devScriptCsp, "script-src 'self'")
            .replace(devConnectCsp, "connect-src 'none'")
        },
      },
    ],
  },
})
