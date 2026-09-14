import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
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