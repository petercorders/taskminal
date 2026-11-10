import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

// package.json 에 "type": "module" 이 없어서 main · preload 는 CJS 로 나온다.
// sandbox: true 인 preload 는 CJS 여야 한다 (ESM preload 는 샌드박스에서 못 읽음).
export default defineConfig({
  main: {
    // host = 셸 지킴이(16단계) — 앱 밖에서 ELECTRON_RUN_AS_NODE 로 도는 둘째 입구 (out/main/host.js)
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts'), host: resolve(__dirname, 'src/main/ptyhost/host-entry.ts') } } },
  },
  preload: {
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    plugins: [react()],
  },
})
