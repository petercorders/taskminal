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
