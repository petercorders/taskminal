import type { ElectronApplication, Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// e2e 가 미리 깔아 두는 저장 파일. 앱이 쓰는 모양(AppState version 1)과 같아야 normalizeState 를 통과한다.

export interface SeedTask {
  id: string
  name: string
  paneId: string
  cwd?: string
  groupId?: string | null
  color?: string | null
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
})

export function seedState(userData: string, tasks: SeedTask[], groups: Array<{ id: string; name: string }> = []): void {
  const state = {
    version: 1,
    tasks: tasks.map(taskJson),
    activeTaskId: tasks[0]?.id ?? null,
    settings: defaultSettings(groups),
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
    throw new Error(`창이 뜨지 않음 (pid ${app.process().pid}) 창=${JSON.stringify(windows)} 출력=${out.slice(-1500)} 원래 오류=${String(error)}`)
  }
}
