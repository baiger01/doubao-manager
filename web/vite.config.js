import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';

// 版本号单一来源:读根目录 package.json 的 version,注入为全局常量 __APP_VERSION__,
// 界面各处直接引用,改 package.json 版本即全联动。
const rootPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
);

// Vite 构建输出直接覆盖 Express 静态目录 ../public，
// Electron 仍然通过 server.js 的 express.static(publicDir) 提供页面，零改动。
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  build: {
    outDir: fileURLToPath(new URL('../public', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome120',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        // 固定文件名,方便 index.html 引用,避免 hash 变动残留
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  },
  server: {
    port: 5273,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:9527', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:9527', ws: true }
    }
  }
});
