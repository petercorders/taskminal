import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, runCli, seedState, waitLoaded } from './helpers'

// 24단계 이어받기: 오래 안 본 일감을 열면 요약 카드 · 일감 메모 칸
let userData: string
let app: ElectronApplication | undefined
let win: Page
const MIN = 60_000

async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await waitLoaded(win)
}
/** 저장 파일의 일감 칸을 고친다 (lastViewedAt · notes) */
function patchTask(id: string, patch: Record<string, unknown>) {
  const file = join(userData, 'state.json')
  const s = JSON.parse(readFileSync(file, 'utf8')) as { tasks: Array<Record<string, unknown>> }
  s.tasks = s.tasks.map((t) => (t['id'] === id ? { ...t, ...patch } : t))
  writeFileSync(file, JSON.stringify(s))
}
const menu = (id: string) => app!.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(), id)
// 확인 필요인 일감은 사이드바 위 '확인 필요' 칸(attention-row)으로 옮겨 간다 — 어느 칸이든 그 일감 줄
const taskRow = (name: string) => win.locator(`li[data-task-name="${name}"]`)
const card = () => win.getByTestId('resume-card')
const shown = (testId: string) => win.locator(`[data-testid="task-view"][aria-hidden="false"] [data-testid="${testId}"]`)

test.describe.configure({ timeout: 90_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(userData, [
    { id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: userData },
    { id: 'task-b', name: 'B 일감', paneId: 'pane-b', cwd: userData },
  ])
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

test("verify: 31분 안 본 일감 + 그 사이 확인 필요 → 고르면 카드 맨 위 '확인 필요' · Esc → 다시 보기 · ⌥⌘R(메뉴)", async () => {
  patchTask('task-b', { lastViewedAt: Date.now() - 31 * MIN })
  await launch()
  // 그 사이 에이전트가 확인을 부탁했다 (A 를 보는 동안)
  expect((await runCli(userData, 'notify', '--task', 'B 일감', '배포해도 될까요?')).code).toBe(0)
  await expect(taskRow('B 일감')).toHaveClass(/\battention\b/)
  await expect(card()).toHaveCount(0)

  await taskRow('B 일감').click()
  await expect(card()).toBeVisible()
  const top = card().getByTestId('resume-top')
  await expect(top).toHaveAttribute('data-kind', 'attention')
  await expect(top).toContainText('확인 필요')
  await expect(top).toContainText('배포해도 될까요?')
  await expect(top).toContainText('터미널 보기')
  await expect(card().getByTestId('resume-tip')).toContainText('30분 넘게 안 본 일감이라 그 사이 일을 모았어요')
  await expect(card()).toBeFocused()
  // 보고 있으니 사이드바의 확인 필요는 꺼진다 — 카드는 연 순간의 사실을 들고 있다
  await expect(taskRow('B 일감')).not.toHaveClass(/\battention\b/)
  await win.screenshot({ path: 'test-results/resume-card.png' })

  await win.keyboard.press('Escape')
  await expect(card()).toHaveCount(0)
  const toast = win.getByTestId('toast')
  await expect(toast).toContainText('요약을 닫았어요')
  await toast.getByRole('button', { name: '다시 보기' }).click()
  await expect(card().getByTestId('resume-top')).toContainText('확인 필요')
  // 처음 한 번 안내는 다시 볼 때 없다
  await expect(card().getByTestId('resume-tip')).toHaveCount(0)
  await expect(card()).toBeFocused()
  await win.keyboard.press('Escape')
  await expect(card()).toHaveCount(0)
  await expect(shown('resume-button')).toBeVisible()
  await menu('resume-show')
  await expect(card().getByTestId('resume-top')).toContainText('확인 필요')
  await expect(card()).toBeFocused()
  // ↩ = 그 터미널로 · 카드는 내린다
  await win.keyboard.press('Enter')
  await expect(card()).toHaveCount(0)
  await expect(win.getByTestId('pane-pane-b').locator('textarea')).toBeFocused()
  // 다른 일감으로 갔다 바로 돌아오면 다시 뜨지 않는다(방금 봄)
  await taskRow('A 일감').click()
  await taskRow('B 일감').click()
  await expect(shown('tab-view')).toBeVisible()
  await expect(card()).toHaveCount(0)
})

test('메모 칸: 더하기 · 체크 · 할 일 수 · 껐다 켜도 남음 · 새 사실이 없으면 오래 안 봐도 카드 없음', async () => {
  patchTask('task-a', { lastViewedAt: Date.now() - 90 * MIN })
  await launch()
  // A: 오래 안 봤지만 그 사이 생긴 것이 없다 → 카드 없음
  await expect(shown('tab-view')).toBeVisible()
  await expect(card()).toHaveCount(0)

  await shown('notes-button').click()
  const input = win.getByTestId('notes-input')
  await expect(input).toBeFocused()
  await input.fill('릴리스 노트 쓰기')
  await input.press('Enter')
  await input.fill('PR 리뷰 답하기')
  await input.press('Enter')
  // 다시 띄우면 win 이 바뀐다 — 부를 때마다 찾는다
  const notes = () => win.getByTestId('notes-panel').getByTestId('note')
  await expect(notes()).toHaveCount(2)
  await expect(shown('notes-button')).toContainText('할 일 2')
  await notes().filter({ hasText: '릴리스 노트 쓰기' }).getByRole('checkbox').check()
  await expect(shown('notes-button')).toContainText('할 일 1')
  await win.screenshot({ path: 'test-results/resume-notes.png' })
  // 메뉴로 닫기 · 열기
  await menu('notes')
  await expect(win.getByTestId('notes-panel')).toHaveCount(0)

  await app!.close()
  app = undefined
  await launch()
  await expect(shown('notes-button')).toContainText('할 일 1')
  await menu('notes')
  await expect(notes()).toHaveCount(2)
  await expect(notes().filter({ hasText: '릴리스 노트 쓰기' }).getByRole('checkbox')).toBeChecked()
  await expect(notes().filter({ hasText: 'PR 리뷰 답하기' }).getByRole('checkbox')).not.toBeChecked()
  await notes().filter({ hasText: 'PR 리뷰 답하기' }).getByRole('button').click()
  await expect(notes()).toHaveCount(1)
})
