import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { firstWindow, seedState } from './helpers'

// 18단계 출시 기본기: 업데이트(로컬 가짜 피드 + 진짜 electron-updater) · 첫 실행 안내 · 오류 기록 · 지난번 꺼짐.
let userData: string
let app: ElectronApplication | undefined
let win: Page
let server: Server | undefined
/** 피드가 받은 요청 경로 */
let requests: string[]
/** 피드가 내줄 것 — null 이면 404 */
let feed: { version: string; zip: Buffer } | null

test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  requests = []
  feed = null
  app = undefined
})
test.afterEach(async () => {
  await app?.close()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = undefined
  rmSync(userData, { recursive: true, force: true })
})

const ZIP = (v: string) => `Taskminal-${v}-arm64-mac.zip`
function latestYml(version: string, zip: Buffer): string {
  const sha512 = createHash('sha512').update(zip).digest('base64')
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${ZIP(version)}`,
    `    sha512: ${sha512}`,
    `    size: ${zip.length}`,
    `path: ${ZIP(version)}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-11-11T00:00:00.000Z'",
    'releaseNotes: "- 대화 pane\\n- 변경 검토\\n- 고친 것 12개\\n- 하나\\n- 둘"',
    '',
  ].join('\n')
}
async function startFeed(): Promise<string> {
  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!
    requests.push(path)
    if (feed && path === '/latest-mac.yml') {
      res.writeHead(200, { 'Content-Type': 'text/yaml' })
      return void res.end(latestYml(feed.version, feed.zip))
    }
    if (feed && path === `/${ZIP(feed.version)}`) {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': feed.zip.length })
      return void res.end(feed.zip)
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`
}

async function launch(env: Record<string, string> = {}): Promise<void> {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_UPDATE_FIRST_MS: '600000', ...env } })
  win = await firstWindow(app)
  // 사이드바는 상태를 읽는 중에도 그려지고, 그동안 온 명령은 버린다(App runCommand 의 loading 막음) — 읽기가 끝난 화면까지 기다린다
  await expect(win.locator('[data-testid="task-view"], [data-testid="empty-view"], [data-testid="first-run"]').first()).toBeVisible()
}
async function close(): Promise<void> {
  await app!.close()
  app = undefined
}
/** 메뉴 항목 — 합성 키는 네이티브 메뉴를 부르지 않는다 */
const menu = (id: string) => app!.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(), id)
/** ⌘P 전용 명령(키 없음) — 메뉴와 같은 길(app:command) */
const command = (id: string) => app!.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', id), id)
const clipboard = () => app!.evaluate(({ clipboard }) => clipboard.readText())
const banner = (key: string) => win.getByTestId(`update-banner-${key}`)
const status = () => win.getByTestId('update-status')

test.describe('업데이트 (로컬 피드)', () => {
  test('메뉴 "업데이트 확인…" → 받기 → 줄 · 바뀐 것 요약 · 받은 파일은 임시 폴더에 → 다음에 → 사이드바 칩 → 설정 › 정보', async () => {
    feed = { version: '0.1.1', zip: Buffer.alloc(300_000, 7) }
    const url = await startFeed()
    seedState(userData, [{ id: 't', name: '업데이트', paneId: 'p1' }])
    await launch({ TASKMINAL_UPDATE_FEED: url })
    await menu('update-check')
    await expect(win.getByRole('heading', { name: '설정 — 정보' })).toBeVisible()
    await expect(banner('downloaded')).toContainText('Taskminal 0.1.1 을 내려받았어요', { timeout: 15_000 })
    await expect(banner('downloaded')).toContainText('대화 pane · 변경 검토 · 고친 것 12개 · 외 2개')
    await expect(banner('downloaded')).toContainText('다시 시작해도 셸은 그대로 이어져요')
    await expect(status()).toHaveText('● 0.1.1 설치 가능')
    expect(requests).toEqual(expect.arrayContaining(['/latest-mac.yml', `/${ZIP('0.1.1')}`]))
    // 받은 zip 은 실제 ~/Library/Caches 가 아니라 시험 폴더에
    const pending = join(userData, 'caches', 'taskminal-updater', 'pending')
    expect(readdirSync(pending)).toContain(ZIP('0.1.1'))
    expect(existsSync(join(homedir(), 'Library', 'Caches', 'taskminal-updater', 'pending', ZIP('0.1.1')))).toBe(false)
    await win.screenshot({ path: 'test-results/release-downloaded.png' })

    await win.keyboard.press('Escape') // 설정 닫기
    await banner('downloaded').getByRole('button', { name: '다음에' }).click()
    await expect(banner('downloaded')).toHaveCount(0)
    await expect(win.getByTestId('update-chip')).toHaveText('● 0.1.1 설치 가능')
    await win.getByTestId('update-chip').click()
    await expect(win.getByRole('heading', { name: '설정 — 정보' })).toBeVisible()
    await win.screenshot({ path: 'test-results/release-chip-about.png' })
  })

  test('이 버전 건너뛰기 → 다시 켜고 확인해도 줄이 안 뜨고 "건너뜀" — 다시 알리기로 되돌린다', async () => {
    feed = { version: '0.1.1', zip: Buffer.alloc(1000, 1) }
    const url = await startFeed()
    seedState(userData, [{ id: 't', name: '건너뛰기', paneId: 'p1' }])
    await launch({ TASKMINAL_UPDATE_FEED: url })
    await menu('update-check')
    await expect(win.getByRole('heading', { name: '설정 — 정보' })).toBeVisible() // 열린 뒤에 닫는다 — 먼저 누르면 늦게 열린 설정이 줄을 가린다
    await win.keyboard.press('Escape')
    await expect(win.getByTestId('settings')).toHaveCount(0)
    await banner('downloaded').getByRole('button', { name: '이 버전 건너뛰기' }).click()
    await expect(banner('downloaded')).toHaveCount(0)
    await close()

    await launch({ TASKMINAL_UPDATE_FEED: url })
    await menu('update-check')
    await expect(status()).toHaveText('● 최신이에요 · 0.1.1 건너뜀', { timeout: 15_000 })
    await expect(banner('downloaded')).toHaveCount(0)
    await win.getByRole('button', { name: '다시 알리기' }).click()
    await win.getByRole('button', { name: '지금 확인' }).click()
    await expect(status()).toHaveText('● 0.1.1 설치 가능', { timeout: 15_000 })
  })

  test('다시 시작해서 설치 — 서명 없는 개발 앱이라 Squirrel 이 거절 → 빨간 줄 · 앱은 그대로 · 오류 기록에 한 줄', async () => {
    feed = { version: '0.1.1', zip: Buffer.alloc(1000, 2) }
    const url = await startFeed()
    seedState(userData, [{ id: 't', name: '설치', paneId: 'p1' }])
    await launch({ TASKMINAL_UPDATE_FEED: url })
    await menu('update-check')
    await expect(win.getByRole('heading', { name: '설정 — 정보' })).toBeVisible() // 열린 뒤에 닫는다 — 먼저 누르면 늦게 열린 설정이 줄을 가린다
    await win.keyboard.press('Escape')
    await expect(win.getByTestId('settings')).toHaveCount(0)
    await banner('downloaded').getByRole('button', { name: '다시 시작해서 설치' }).click()
    await expect(banner('install-failed')).toContainText('0.1.1 을 설치하지 못했어요', { timeout: 20_000 })
    await expect(banner('install-failed')).toContainText('알 수 없는 오류예요 · 지금 버전(0.1.0)은 그대로예요')
    await win.screenshot({ path: 'test-results/release-install-failed.png' })
    expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1) // 꺼지지 않았다
    await banner('install-failed').getByRole('button', { name: '오류 기록 보기' }).click()
    await expect(win.getByTestId('errlog-row').filter({ hasText: '업데이트를 설치하지 못했어요' })).toHaveCount(1)
  })

  test('피드가 없으면(404) 실패 줄 · 다시 시도는 확인부터 다시', async () => {
    const url = await startFeed()
    seedState(userData, [{ id: 't', name: '실패', paneId: 'p1' }])
    await launch({ TASKMINAL_UPDATE_FEED: url })
    await menu('update-check')
    await expect(status()).toContainText('✕ 확인하지 못했어요 · 받는 곳에 새 버전 정보가 없어요 · 6시간 뒤 다시 해요', { timeout: 15_000 })
    const before = requests.filter((r) => r === '/latest-mac.yml').length
    feed = { version: '0.1.1', zip: Buffer.alloc(1000, 3) }
    await win.getByRole('button', { name: '다시 시도' }).click()
    await expect(status()).toHaveText('● 0.1.1 설치 가능', { timeout: 15_000 })
    expect(requests.filter((r) => r === '/latest-mac.yml').length).toBe(before + 1)
  })
})

test.describe('첫 실행 안내', () => {
  test('state.json 이 없으면 세 장 — 홈 폴더로 첫 일감 · 명령 복사 · 시작하기, 다시 켜면 안 뜨고 ⌘P 로 다시 본다', async () => {
    await launch({ TASKMINAL_FIRST_RUN: '' })
    const guide = win.getByTestId('first-run')
    await expect(guide).toHaveAttribute('data-page', '1')
    await expect(guide).toContainText('일감 하나 = 폴더 하나 + 터미널 묶음')
    await win.screenshot({ path: 'test-results/release-first-run-1.png' })
    await win.keyboard.press('Enter') // 이 폴더로 첫 일감 만들기
    await expect(guide).toHaveAttribute('data-page', '2')
    await guide.getByRole('button', { name: /명령 복사/ }).click()
    await expect.poll(clipboard).toBe('claude config set --global preferredNotifChannel terminal_bell')
    await win.screenshot({ path: 'test-results/release-first-run-2.png' })
    await win.keyboard.press('Enter')
    await expect(guide).toContainText('일감과 설정은 이 Mac 에 저장돼요')
    await win.keyboard.press('Enter') // 시작하기
    await expect(guide).toHaveCount(0)
    await expect(win.getByTestId('task-view').and(win.locator('[data-task-name="홈"]'))).toBeVisible()
    const pane = win.locator('[data-testid^="pane-"]').first()
    await pane.click()
    await win.keyboard.type('pwd')
    await win.keyboard.press('Enter')
    await expect(pane.locator('.xterm-rows')).toContainText(homedir())
    await close()

    await launch({ TASKMINAL_FIRST_RUN: '' })
    await expect(win.getByTestId('sidebar')).toContainText('홈')
    await expect(win.getByTestId('first-run')).toHaveCount(0)
    await command('first-run')
    await expect(win.getByTestId('first-run')).toContainText('새 일감은 ⌘N') // 다시 보기 — 첫 장에서 만들지 않는다
    await win.keyboard.press('Enter')
    await win.keyboard.press('Enter')
    await win.keyboard.press('Enter')
    await expect(win.getByTestId('first-run')).toHaveCount(0)
    await expect(win.locator('[data-testid="task-view"]')).toHaveCount(1)
  })

  test('Esc 로 건너뛰면 아무것도 만들지 않고, 저장할 것이 없어도 다시 뜨지 않는다', async () => {
    await launch({ TASKMINAL_FIRST_RUN: '' })
    await expect(win.getByTestId('first-run')).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(win.getByTestId('first-run')).toHaveCount(0)
    await expect(win.getByTestId('empty-view')).toBeVisible()
    await close()
    await launch({ TASKMINAL_FIRST_RUN: '' })
    await expect(win.getByTestId('empty-view')).toBeVisible()
    await expect(win.getByTestId('first-run')).toHaveCount(0)
  })
})

test.describe('오류 기록 · 지난번 꺼짐', () => {
  test('상태 저장 실패가 오류 기록에 묶여 남는다 — 거르기 · 복사 · 빈 상태', async () => {
    seedState(userData, [{ id: 't', name: '기록', paneId: 'p1' }])
    await launch()
    await command('error-log')
    await expect(win.getByTestId('errlog-empty')).toContainText('최근 7일 동안 오류가 없어요')
    await win.keyboard.press('Escape')
    // state.json 자리를 폴더로 — 다음 저장이 rename 에서 실패한다
    unlinkSync(join(userData, 'state.json'))
    mkdirSync(join(userData, 'state.json', 'x'), { recursive: true })
    for (const size of ['font-bigger', 'font-smaller']) {
      await command(size)
      await win.waitForTimeout(500) // 저장 디바운스(300ms) 한 번씩
    }
    await command('error-log')
    const row = win.getByTestId('errlog-row').filter({ hasText: '상태를 저장하지 못했어요' })
    await expect(row).toContainText('상태를 저장하지 못했어요 ×2')
    await win.screenshot({ path: 'test-results/release-errlog.png' })
    await row.getByRole('button', { name: '복사' }).click()
    await expect.poll(clipboard).toMatch(/^상태를 저장하지 못했어요\n.+\n오류 · 2번 · 마지막 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    await win.getByRole('radio', { name: '경고' }).click()
    await expect(win.getByTestId('errlog-empty')).toContainText('최근 7일 동안 경고가 없어요')
    // 기록 파일은 0600
    const logs = join(userData, 'logs')
    const file = readdirSync(logs).find((n) => n.startsWith('main-'))!
    expect((await import('node:fs')).statSync(join(logs, file)).mode & 0o777).toBe(0o600)
  })

  test('지난번이 정상으로 끝나지 않았으면(running 표시 파일) 다음 실행에 한 번 알리고, 오류 기록에도 남는다', async () => {
    seedState(userData, [{ id: 't', name: '꺼짐', paneId: 'p1' }])
    writeFileSync(join(userData, 'running'), '12345')
    await launch()
    await expect(banner('crashed')).toContainText('지난번에 Taskminal 이 갑자기 꺼졌어요')
    await win.screenshot({ path: 'test-results/release-crashed.png' })
    await banner('crashed').getByRole('button', { name: '오류 기록 보기' }).click()
    await expect(win.getByTestId('errlog-row').filter({ hasText: '지난번에 Taskminal 이 갑자기 꺼졌어요' })).toHaveCount(1)
    await close()
    // 정상으로 끄면 표시 파일이 없어 다음엔 알리지 않는다
    expect(existsSync(join(userData, 'running'))).toBe(false)
    await launch()
    await expect(win.getByTestId('sidebar')).toContainText('꺼짐')
    await expect(banner('crashed')).toHaveCount(0)
  })
})
