import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 25단계 원격 — 실제 서버 · sshd 없이 가짜 ssh(TASKMINAL_SSH)로. 가짜는 받은 인자를 적고, 옆 mode 파일대로 행동한다:
//  ok = 원격 셸(sh) · fail = 연결 거절(255) · new-host = 지문 질문 · key-changed = 키 바뀜 · auth = 인증 거절
let userData: string
let fake: string
let app: ElectronApplication
let win: Page

const FAKE_SSH = `#!/bin/bash
dir="$(cd "$(dirname "$0")" && pwd)"
n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/count"
for a in "$@"; do printf '%s\\n' "$a"; done > "$dir/args-$n"
case "$(cat "$dir/mode" 2>/dev/null)" in
  fail) echo "ssh: connect to host nas port 22: Connection refused" >&2; exit 255 ;;
  new-host)
    echo "The authenticity of host 'nas (10.0.0.2)' can't be established."
    echo "ED25519 key fingerprint is SHA256:abcDEF123+/xyz."
    printf "Are you sure you want to continue connecting (yes/no/[fingerprint])? "
    read -r ans
    if [ "$ans" != yes ]; then echo "Host key verification failed."; exit 255; fi
    echo "Warning: Permanently added 'nas' (ED25519) to the list of known hosts." ;;
  key-changed)
    echo "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@"
    echo "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @"
    echo "Host key verification failed."
    exit 255 ;;
  auth) echo "peter@nas: Permission denied (publickey)."; exit 255 ;;
esac
echo "REMOTE_READY_$n"
PS1='nas$ ' exec /bin/sh -i
`

test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  fake = join(userData, 'fake')
  mkdirSync(fake)
  writeFileSync(join(fake, 'ssh'), FAKE_SSH)
  chmodSync(join(fake, 'ssh'), 0o755)
  writeFileSync(join(fake, 'mode'), 'ok')
  writeFileSync(join(fake, 'ssh_config'), 'Host nas\n  HostName 10.0.0.2\nHost *.corp !x\nHost dev box # 둘\nMatch all\n')
})
test.afterEach(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
})

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_SSH: join(fake, 'ssh'), TASKMINAL_SSH_CONFIG: join(fake, 'ssh_config'), TASKMINAL_SSH_RETRY_MS: '60' },
  })
  win = await firstWindow(app)
  await waitLoaded(win)
}
/** 원격 일감 하나를 깔아 둔다 */
function seedRemote(tmux = true): void {
  seedState(userData, [{ id: 'r', name: 'NAS', paneId: 'rp', cwd: '/srv/app' }])
  const file = join(userData, 'state.json')
  const s = JSON.parse(readFileSync(file, 'utf8'))
  s.tasks[0].host = 'nas'
  if (!tmux) s.tasks[0].remoteTmux = false
  writeFileSync(file, JSON.stringify(s))
}
const mode = (m: string) => writeFileSync(join(fake, 'mode'), m)
const calls = () => (existsSync(join(fake, 'count')) ? Number(readFileSync(join(fake, 'count'), 'utf8')) : 0)
const argsOf = (n: number) => readFileSync(join(fake, `args-${n}`), 'utf8').trimEnd().split('\n')
const command = (id: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', c), id)
const screen = (id: string) => win.getByTestId(`pane-${id}`).locator('.xterm-rows')
const band = () => win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="remote-band"]')
const hostChip = () => win.locator('[data-testid="task-row"][data-task-name="NAS"] [data-testid="task-host"]')

test('새 일감 ⌥2 원격: ~/.ssh/config 호스트 · ssh 인자(ControlPath · -- · tmux 세션) · 분할 pane 도 같은 호스트', async () => {
  seedState(userData, [])
  await launch()
  await command('new-task')
  const dialog = win.getByRole('dialog')
  await dialog.getByRole('textbox').first().fill('NAS')
  await win.keyboard.press('Alt+Digit2')
  await expect(dialog.getByTestId('where-remote')).toHaveAttribute('aria-pressed', 'true')
  // 와일드카드 · 부정 · Match 는 빼고, 한 줄의 여러 이름은 따로
  await expect(dialog.locator('#new-task-hosts option')).toHaveCount(3)
  expect(await dialog.locator('#new-task-hosts option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).toEqual(['nas', 'dev', 'box'])
  // 잘못된 호스트(옵션 주입)는 만들지 않는다
  await dialog.getByLabel('호스트').fill('-oProxyCommand=x')
  await win.keyboard.press('Meta+Enter')
  await expect(dialog.getByTestId('new-task-error')).toContainText('호스트를 확인하세요')
  await dialog.getByLabel('호스트').fill('nas')
  await dialog.getByLabel('원격 폴더').fill("/srv/it's")
  await dialog.screenshot({ path: 'test-results/remote-dialog.png' })
  await win.keyboard.press('Meta+Enter')
  await expect(dialog).toBeHidden()

  await expect.poll(() => calls()).toBe(1)
  const paneId = await win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="pane-slot"]').first().getAttribute('data-pane-id')
  await expect(screen(paneId!)).toContainText('REMOTE_READY_1')
  const a = argsOf(1)
  expect(a.slice(0, 2)).toEqual(['-t', '-o'])
  expect(a).toContain(`ControlPath=${join(userData, 'ssh')}/%C`)
  expect(a).toContain('ControlMaster=auto')
  const dash = a.indexOf('--')
  expect(a[dash + 1]).toBe('nas')
  expect(a[dash + 2]).toContain(`cd '/srv/it'\\''s'`)
  expect(a[dash + 2]).toContain(`tmux new-session -A -s tm-${paneId!.replace(/[^A-Za-z0-9_-]/g, '')}`)
  expect(a).toHaveLength(dash + 3)
  await expect(hostChip()).toContainText('⇄ nas')
  await expect(hostChip()).toHaveClass(/\bup\b/)
  const saved = JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))
  expect(saved.tasks[0]).toMatchObject({ host: 'nas', cwd: "/srv/it's" })

  // 분할 → 같은 호스트로 두 번째 ssh(ControlMaster 가 연결 하나를 나눈다)
  await command('split-right')
  await expect.poll(() => calls()).toBe(2)
  expect(argsOf(2)[argsOf(2).indexOf('--') + 1]).toBe('nas')
  await win.screenshot({ path: 'test-results/remote.png' })
})

test('끊기면(255) 1 · 2 · 4 · 8 · 8 걸음으로 다섯 번 다시 붙고, 다 실패하면 못 붙음 띠 · ⌘R 로 처음부터 — 그 사이 친 키는 버린다', async () => {
  seedRemote()
  await launch()
  await expect(screen('rp')).toContainText('REMOTE_READY_1')
  mode('fail')
  await win.getByTestId('pane-rp').click()
  await win.keyboard.type('exit 255')
  await win.keyboard.press('Enter')
  await expect(band()).toHaveAttribute('data-kind', 'retry')
  await win.keyboard.type('lost-keys') // 끊긴 동안 친 키 — 버린다
  await expect(band()).toHaveAttribute('data-kind', 'gave-up', { timeout: 15_000 })
  expect(calls()).toBe(6) // 처음 1 + 다시 5
  await expect(hostChip()).toHaveClass(/\bdown\b/)
  await expect(screen('rp')).toContainText('다시 붙지 못했어요')
  await win.screenshot({ path: 'test-results/remote-down.png' })

  mode('ok')
  await command('remote-reconnect')
  await expect(screen('rp')).toContainText('REMOTE_READY_7')
  await expect(band()).toHaveCount(0)
  await expect(hostChip()).toHaveClass(/\bup\b/)
  // 버린 키가 새 연결로 가지 않았다
  await win.getByTestId('pane-rp').click()
  await win.keyboard.type('echo AFTER_$((40+2))')
  await win.keyboard.press('Enter')
  await expect(screen('rp')).toContainText('AFTER_42')
  expect(await screen('rp').textContent()).not.toContain('lost-keysecho')
  // 붙어 있을 때 ⌘R 은 아무것도 안 한다
  await command('remote-reconnect')
  await win.waitForTimeout(300)
  expect(calls()).toBe(7)
})

test('처음 보는 서버: 지문 띠 → 맞아요면 yes 로 연결, 취소면 no → 다시 붙지 않음', async () => {
  seedRemote()
  mode('new-host')
  await launch()
  await expect(band()).toHaveAttribute('data-kind', 'new-host')
  await expect(band()).toContainText('SHA256:abcDEF123+/xyz')
  await win.screenshot({ path: 'test-results/remote-new-host.png' })
  await band().getByTestId('remote-yes').click()
  await expect(screen('rp')).toContainText('REMOTE_READY_1')
  await expect(band()).toHaveCount(0)

  // 다음 연결(⌘R 은 붙어 있어 무시 → 끊고 새로)에서 취소
  await win.getByTestId('pane-rp').click()
  await win.keyboard.type('exit 255')
  await win.keyboard.press('Enter')
  await expect(band()).toHaveAttribute('data-kind', 'new-host', { timeout: 10_000 })
  await band().getByTestId('remote-no').click()
  await expect(band()).toHaveAttribute('data-kind', 'refused')
  const n = calls()
  await win.waitForTimeout(500)
  expect(calls()).toBe(n)
})

test('서버 키가 바뀜: 빨간 띠 · 다시 붙지 않음 · ssh-keygen -R 명령 복사', async () => {
  seedRemote()
  mode('key-changed')
  await launch()
  await expect(band()).toHaveAttribute('data-kind', 'key-changed')
  await expect(hostChip()).toHaveClass(/\bdown\b/)
  await win.waitForTimeout(500)
  expect(calls()).toBe(1)
  await band().getByTestId('remote-copy-fix').click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('ssh-keygen -R nas')
  await win.screenshot({ path: 'test-results/remote-key-changed.png' })
})

test('키 인증 거절: 띠 · 다시 붙지 않음 · tmux 끔이면 원격 명령에 tmux 가 없다', async () => {
  seedRemote(false)
  mode('auth')
  await launch()
  await expect(band()).toHaveAttribute('data-kind', 'auth')
  await win.waitForTimeout(500)
  expect(calls()).toBe(1)
  const a = argsOf(1)
  expect(a[a.length - 1]).not.toContain('tmux')
  // 고치고 ⌘R
  mode('ok')
  await command('remote-reconnect')
  await expect(screen('rp')).toContainText('REMOTE_READY_2')
})

test('다시 붙기를 기다리는 사이 pane 을 닫으면 그 pane 에 다시 spawn 하지 않는다', async () => {
  seedRemote()
  await launch()
  await expect(screen('rp')).toContainText('REMOTE_READY_1')
  // 기다림을 길게: 실패 중 첫 기다림(60ms)보다 닫기가 먼저 오게 하려고 연결이 계속 실패하는 동안 닫는다
  mode('fail')
  await command('split-right')
  await expect.poll(() => calls()).toBeGreaterThanOrEqual(2)
  await win.getByTestId('pane-rp').click()
  await win.keyboard.type('exit 255')
  await win.keyboard.press('Enter')
  await expect(band()).toBeVisible()
  await command('close-pane')
  const n = calls()
  await win.waitForTimeout(1500)
  // 남은 분할 pane 의 다시 붙기만 더 돌 수 있다 — 닫힌 rp 의 인자(tm-rp)는 더 오지 않는다
  for (let i = n + 1; i <= calls(); i++) expect(argsOf(i).at(-1)).not.toContain('tm-rp;')
})
