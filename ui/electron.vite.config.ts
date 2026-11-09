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
          return html.replace("script-src 'self' 'unsafe-inline'", "script-src 'self'")
            .replace("connect-src 'self' ws://localhost:* ws://127.0.0.1:*", "connect-src 'none'")
        },
      },
    ],
  },
})
