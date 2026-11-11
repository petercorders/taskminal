import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// e2e 가 미리 깔아 두는 저장 파일. 앱이 쓰는 모양(AppState version 1)과 같아야 normalizeState 를 통과한다.

export interface SeedTask {
  id: string
  name: string
  paneId: string
  cwd?: string
  groupId?: string | null
  color?: string | null
  /** 빠른 명령 (20단계) */
  quickCommands?: Array<Record<string, unknown>>
}

export function taskJson(t: SeedTask) {
  const cwd = t.cwd ?? '~'
  return {
    id: t.id,
    name: t.name,
    cwd,
    statusId: 'doing',
    groupId: t.groupId ?? null,
    color: t.color ?? null,
    tabs: [{ id: `${t.id}-tab`, layout: { type: 'pane', paneId: t.paneId }, activePaneId: t.paneId }],
    activeTabId: `${t.id}-tab`,
    panes: { [t.paneId]: { id: t.paneId, cwd } },
    createdAt: 1,
    ...(t.quickCommands ? { quickCommands: t.quickCommands } : {}),
  }
}

const defaultSettings = (groups: Array<{ id: string; name: string }>) => ({
  statuses: [
    { id: 'doing', name: '진행 중', color: '#79b8ff' },
    { id: 'wait', name: '대기', color: '#e5b567' },
    { id: 'done', name: '완료', color: '#8b9097' },
  ],
  groups,
  templates: [{ id: 'tpl-basic', name: '기본', tabs: [{ layout: { pane: {} } }] }],
  fontSize: 13,
  shell: null,
  // 실행 중인 명령이 있으면 끄기 전에 묻는 설정(기본 켜짐)은 시험 정리(app.close)를 대화상자에서 멈추게 한다 → 그것을 보는 시험만 켠다
  confirmQuit: false,
})

export function seedState(userData: string, tasks: SeedTask[], groups: Array<{ id: string; name: string }> = [], settings: Record<string, unknown> = {}): void {
  const state = {
    version: 1,
    tasks: tasks.map(taskJson),
    activeTaskId: tasks[0]?.id ?? null,
    settings: { ...defaultSettings(groups), ...settings },
  }
  writeFileSync(join(userData, 'state.json'), JSON.stringify(state))
}

/**
 * app.firstWindow() 대신 — 창이 안 뜨면 그때의 창 목록 · main 출력을 오류에 담는다.
 * 전체 e2e 에서 가끔 창이 안 뜨는 원인을 찾으려고 둔다(2026-11-10: 7 · 9단계 전체 실행에서 한 건씩, 따로 25번 띄우면 0건).
 */
export async function firstWindow(app: ElectronApplication): Promise<Page> {
  let out = ''
  app.process().stderr?.on('data', (d) => (out += String(d)))
  app.process().stdout?.on('data', (d) => (out += String(d)))
  try {
    return await app.firstWindow({ timeout: 20_000 })
  } catch (error) {
    const windows = await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), url: w.webContents.getURL(), loading: w.webContents.isLoading(), crashed: w.webContents.isCrashed() })),
      )
      .catch((e: unknown) => `main 응답 없음: ${String(e)}`)
    const report = `창이 뜨지 않음 (pid ${app.process().pid}) 창=${JSON.stringify(windows)} 출력=${out.slice(-1500)} 원래 오류=${String(error)}`
    // Playwright 가 다음 실행 때 지우는 outputDir(test-results/playwright) 밖에 쌓아 둔다 — 다시 돌리다 진단을 잃지 않게(2026-11-10 11단계에서 한 번 잃음)
    mkdirSync('test-results/launch-hangs', { recursive: true })
    appendFileSync('test-results/launch-hangs/log.txt', `${new Date().toISOString()} ${report}\n`)
    throw new Error(report)
  }
}

/**
 * 상태 읽기가 끝난 화면까지 기다린다 — 사이드바는 읽는 중에도 그려지고, 그동안 온 명령(메뉴 · app:command)은 버린다
 * (App runCommand 의 loading 막음). 창이 뜨자마자 명령을 보내는 시험은 이것부터 (18단계 회고: 메뉴 시험 4건이 이 경합으로 실패).
 */
export async function waitLoaded(win: Page): Promise<void> {
  await expect(win.locator('[data-testid="task-view"], [data-testid="empty-view"], [data-testid="first-run"]').first()).toBeVisible()
}
