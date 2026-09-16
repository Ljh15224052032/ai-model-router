import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// 本地版本号取自 package.json，运行时以 __APP_VERSION__ 全局常量注入，用于「检测更新」
const APP_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
).version

// https://vite.dev/config/
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // dev 环境下 /v1、/api 直接代理到 Router
      '/v1': { target: 'http://127.0.0.1:33333', changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:33333', changeOrigin: true },
    },
  },
})