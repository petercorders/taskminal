import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, taskJson, waitLoaded, selectSettingsSection } from './helpers'

for (const [width, height] of [[640, 400], [900, 600], [1280, 800]]) {
  test(`반응형 ${width}×${height}: 대화·분할 검토·설정·팔레트·긴 모달의 주요 액션에 도달한다`, async () => {
    test.setTimeout(90_000)
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    git('init', '-q', '-b', 'feature/responsive')
    git('config', 'user.name', 'test')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'app.txt'), 'before\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    writeFileSync(join(repo, 'app.txt'), 'after\n')
    seedState(dir, [{ id: 'live', name: '로그인·결제 화면 사용성 개선', paneId: 'p', cwd: repo }])
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    for (let i = 0; i < 30; i++) state.tasks.push({ ...taskJson({ id: `old-${i}`, name: `보관한 일감 ${i}`, paneId: `old-pane-${i}`, cwd: repo }), archivedAt: Date.now() })
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
    let app: ElectronApplication | undefined
    try {
      app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: dir, TASKMINAL_CLAUDE_BIN: resolve('tests/fixtures/fake-claude.mjs') } })
      const win: Page = await firstWindow(app)
      await waitLoaded(win)
      await win.setViewportSize({ width: width!, height: height! })
      const command = async (c: string) => app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
      const shot = async (name: string) => win.screenshot({ path: `test-results/responsive/${width}-${name}.png` })
      const inWindow = async (selector: string) => {
        const box = (await win.locator(selector).last().boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(width! + 1)
        expect(box.y + box.height).toBeLessThanOrEqual(height! + 1)
      }
      await command('chat-new')
      const chat = win.locator('[data-testid="task-view"][aria-hidden="false"]').getByTestId('chat-pane')
      await expect(chat.getByTestId('chat-input')).toBeVisible()
      await chat.getByTestId('chat-input').fill('안녕')
      await chat.getByTestId('chat-input').press('Enter')
      await expect(chat.getByTestId('chat-status')).toContainText('끝남')
      await expect(chat.getByTestId('chat-send')).toBeInViewport({ ratio: 1 })
      await expect(chat.getByTestId('chat-shell')).toBeInViewport({ ratio: 1 })
      await expect(chat.getByTestId('chat-to-tui')).toBeInViewport({ ratio: 1 })
      await expect.poll(() => chat.locator('.chat-input-row').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
      await shot('chat')

      await command('review')
      const review = win.locator('[data-testid="task-view"][aria-hidden="false"]').getByTestId('review-pane')
      await expect(review.getByTestId('review-file')).toHaveCount(1)
      await expect.poll(() => review.locator('.review-head').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
      await expect(review.getByTestId('review-to-commit')).toBeInViewport({ ratio: 1 })
      await expect(chat.getByTestId('chat-send')).toBeInViewport({ ratio: 1 })
      await expect.poll(() => chat.locator('.chat-head').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
      await expect.poll(() => chat.locator('.chat-input-row').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
      await shot('review')

      await command('settings')
      const settings = win.getByTestId('settings')
      for (const section of ['일반', '일감 관리', '모양', '터미널', '단축키', '알림 · 활동', '셸 지킴이', '개인정보', '백업 · 되돌리기', '정보']) {
        await selectSettingsSection(settings, section)
        await expect.poll(() => settings.getByTestId('settings-body').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
      }
      await shot('settings')
      await win.keyboard.press('Escape')

      for (const c of ['new-task', 'archive-open', 'weekly', 'first-run', 'quick-new', 'palette', 'global-find']) {
        await command(c)
        const dialog = win.getByRole('dialog').last()
        await expect(dialog).toBeVisible()
        await inWindow('[role="dialog"]')
        await expect.poll(() => dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
        const buttons = dialog.getByRole('button')
        const last = buttons.last()
        if (await last.count()) {
          await last.scrollIntoViewIfNeeded()
          await expect(last).toBeInViewport({ ratio: 1 })
        }
        await shot(c)
        await win.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
      }
      if (width === 1280) {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.25))
        await command('settings')
        await selectSettingsSection(settings, '일감 관리')
        await expect.poll(() => settings.getByTestId('settings-body').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
        await shot('zoom-125')
      }
    } finally {
      await app?.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })
}
