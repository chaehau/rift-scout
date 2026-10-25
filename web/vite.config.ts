import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
    // 前端只与本地桥接服务通信，不直连 LCU（DEC-002）
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8737',
        changeOrigin: false,
      },
    },
  },
})
