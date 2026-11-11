import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 18단계: 만든 .app(hardened runtime) 을 임시 데이터 폴더로 띄워 지킴이 · node-pty spawn-helper 가 뜨는지.
// `npm run package` 뒤 TASKMINAL_E2E_PACKAGED=1 로만 돈다(평소 e2e 는 개발 빌드).
const APP = join(process.cwd(), 'dist', 'mac-arm64', 'Taskminal.app', 'Contents', 'MacOS', 'Taskminal')
test.skip(process.env['TASKMINAL_E2E_PACKAGED'] !== '1' || !existsSync(APP), 'npm run package 뒤 TASKMINAL_E2E_PACKAGED=1')

test('패키지 앱: 지킴이가 뜨고 셸이 응답한다 · 한글 · 로그인 셸 PATH', async () => {
  const userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-pkg-')))
  seedState(userData, [{ id: 't', name: '패키지', paneId: 'p1' }])
  // Finder 와 비슷하게 PATH · LANG 을 줄인 환경
  const env = { HOME: process.env['HOME'] ?? '', USER: process.env['USER'] ?? '', PATH: '/usr/bin:/bin', TASKMINAL_USER_DATA: userData, TASKMINAL_RENDERER: 'dom', TASKMINAL_QUIT_NOTICE: 'seen' }
  const app = await electron.launch({ executablePath: APP, env })
  try {
    const win = await firstWindow(app)
    await expect.poll(() => win.evaluate(() => window.taskminal.host.view().then((v) => v.state)), { timeout: 15_000 }).toBe('connected')
    const pane = win.getByTestId('pane-p1')
    await pane.click()
    await win.keyboard.type('echo PKG $LANG 한글 $(command -v node >/dev/null && echo node-ok)')
    await win.keyboard.press('Enter')
    await expect(pane.locator('.xterm-rows')).toContainText(/PKG \S*UTF-8 한글/, { timeout: 15_000 })
    // dir 패키징본엔 app-update.yml 이 없다(electron-builder 는 dmg · zip 일 때만) — 확인하지 않음으로 두고 오류를 쌓지 않는다
    expect(await win.evaluate(() => window.taskminal.update.view().then((v) => v.state))).toBe('disabled')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
