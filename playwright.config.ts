import { defineConfig } from '@playwright/test'

// e2e 는 `npm run e2e` (= electron-vite build 뒤 실행). 앱 하나를 띄우는 시험이라 한 번에 하나씩.
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 30_000,
  outputDir: 'test-results/playwright',
  reporter: [['list']],
})
