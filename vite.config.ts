import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 使用相对 base，方便把 dist 目录放到任意静态托管路径下（本地打开、子目录部署都可以）。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
