import { defineConfig } from '@playwright/test'

// 15e: 앱은 보이는 pane 을 WebGL(canvas)로 그리지만, 시험은 DOM 의 글(.xterm-rows)을 읽는다 — 모든 launch 가 process.env 를 넘기므로 여기서 기본 DOM.
// WebGL 을 보는 시험(webgl.spec.ts)만 env 로 webgl 을 준다.
process.env['TASKMINAL_RENDERER'] ??= 'dom'

// e2e 는 `npm run e2e` (= electron-vite build 뒤 실행). 앱 하나를 띄우는 시험이라 한 번에 하나씩.
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 30_000,
  outputDir: 'test-results/playwright',
  reporter: [['list']],
})
