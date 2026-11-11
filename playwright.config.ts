import { defineConfig } from '@playwright/test'

// 15e: 앱은 보이는 pane 을 WebGL(canvas)로 그리지만, 시험은 DOM 의 글(.xterm-rows)을 읽는다 — 모든 launch 가 process.env 를 넘기므로 여기서 기본 DOM.
// WebGL 을 보는 시험(webgl.spec.ts)만 env 로 webgl 을 준다.
process.env['TASKMINAL_RENDERER'] ??= 'dom'
// 16단계: 처음 ⌘Q 안내(셸은 계속 돌아요)가 시험 정리(app.close)를 대화상자에서 멈추게 한다 → 본 것으로. 그 안내를 보는 시험만 지운다.
process.env['TASKMINAL_QUIT_NOTICE'] ??= 'seen'
// 18단계: 첫 실행 안내(state.json 이 없을 때)가 빈 상태로 시작하는 시험을 가리지 않게 → 본 것으로. 그 안내를 보는 시험만 지운다.
process.env['TASKMINAL_FIRST_RUN'] ??= 'seen'

// e2e 는 `npm run e2e` (= electron-vite build 뒤 실행). 앱 하나를 띄우는 시험이라 한 번에 하나씩.
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 30_000,
  outputDir: 'test-results/playwright',
  reporter: [['list']],
})
