import { describe, expect, it } from 'vitest'
import { addTab, createTask, defaultSettings, dropQuick, emptyState, findQuick, normalizeState, putBackQuick, replaceTemplate, saveQuick, taskToTemplate } from '../../src/shared/model'
import type { QuickCommand } from '../../src/shared/quick'
import type { AppState, Template } from '../../src/shared/types'

function ids(prefix = 'id') {
  let n = 0
  return () => `${prefix}${++n}`
}
const qc = (p: Partial<QuickCommand> = {}): QuickCommand => ({ id: 'q1', label: '시험', command: 'npm test', where: 'current', ...p })

function stateWithTask(): AppState {
  const s = emptyState()
  const task = createTask({ name: 'A', cwd: '/w/app', templateId: null, statusId: s.settings.statuses[0]!.id, groupId: null, color: null }, s.settings, ids('t'), 0)
  return { ...s, tasks: [task], activeTaskId: task.id }
}

describe('빠른 명령 — 저장 파일 검증', () => {
  it('일감 · 템플릿 · 모든 일감의 단추가 읽기 · 쓰기를 거쳐 남고, 틀린 것만 버린다', () => {
    const s = stateWithTask()
    const tpl: Template = { id: 'tp', name: '서버', tabs: [{ layout: { pane: {} } }], quickCommands: [qc({ id: 'tq' })] }
    const raw = JSON.parse(
      JSON.stringify({
        ...s,
        tasks: [{ ...s.tasks[0], quickCommands: [qc(), { id: 'bad' }] }],
        settings: { ...s.settings, templates: [tpl], quickCommands: [qc({ id: 'g', where: 'insert' })], hiddenPorts: [5432, 'x', 0, 5432], portTipSeen: true },
      }),
    )
    const out = normalizeState(raw, ids())
    expect(out.tasks[0]!.quickCommands).toEqual([qc()])
    expect(out.settings.templates[0]!.quickCommands).toEqual([qc({ id: 'tq' })])
    expect(out.settings.quickCommands).toEqual([qc({ id: 'g', where: 'insert' })])
    expect(out.settings.hiddenPorts).toEqual([5432])
    expect(out.settings.portTipSeen).toBe(true)
  })
  it('없던 저장 파일은 빈 목록 · 숨긴 포트 없음 · 처음 알림 안 봄', () => {
    const d = defaultSettings()
    expect(d.quickCommands).toEqual([])
    expect(d.hiddenPorts).toEqual([])
    expect(d.portTipSeen).toBe(false)
  })
})

describe('템플릿 ↔ 일감', () => {
  it('템플릿으로 만든 일감에 단추가 출처(▤)와 함께 복사된다', () => {
    const settings = { ...defaultSettings(), templates: [{ id: 'tp', name: '서버', tabs: [{ layout: { pane: {} } }], quickCommands: [qc()] }] }
    const t = createTask({ name: 'A', cwd: '/w', templateId: 'tp', statusId: settings.statuses[0]!.id, groupId: null, color: null }, settings, ids(), 0)
    expect(t.quickCommands).toEqual([qc({ fromTemplate: '서버' })])
  })
  it('일감을 템플릿으로 저장하면 단추가 같이 들어가고 출처 표시는 빠진다', () => {
    const s = stateWithTask()
    const task = { ...s.tasks[0]!, quickCommands: [qc({ fromTemplate: '옛' }), qc({ id: 'q2' })] }
    expect(taskToTemplate(task, '새', ids('n')).quickCommands).toEqual([qc(), qc({ id: 'q2' })])
  })
  it('JSON 편집기로 이름 · 탭을 바꿔도 템플릿의 단추는 남는다', () => {
    const s = emptyState()
    const st = { ...s, settings: { ...s.settings, templates: [{ id: 'tp', name: '서버', tabs: [{ layout: { pane: {} } }], quickCommands: [qc()] }] } }
    const out = replaceTemplate(st, 'tp', { name: '새 이름', tabs: [{ layout: { pane: { command: 'ls' } } }] })
    expect(out.settings.templates[0]!.quickCommands).toEqual([qc()])
  })
})

describe('saveQuick · dropQuick · putBackQuick · findQuick', () => {
  it('일감 · 모든 일감에 더하고 · 지우고 · 되돌린다', () => {
    const s = stateWithTask()
    const taskId = s.tasks[0]!.id
    const a = saveQuick(saveQuick(s, { taskId }, qc()), 'all', qc({ id: 'g' }))
    expect(findQuick(a, { taskId }, 'q1')).toEqual(qc())
    expect(findQuick(a, 'all', 'g')?.id).toBe('g')
    const d = dropQuick(a, { taskId }, 'q1')
    expect(d.removed).toEqual(qc())
    expect(d.state.tasks[0]!.quickCommands).toBeUndefined()
    expect(putBackQuick(d.state, { taskId }, d.removed!, d.index).tasks[0]!.quickCommands).toEqual([qc()])
  })
  it('그 사이 일감이 지워졌으면 아무것도 바꾸지 않는다', () => {
    const s = stateWithTask()
    expect(saveQuick(s, { taskId: 'gone' }, qc())).toBe(s)
    expect(dropQuick(s, { taskId: 'gone' }, 'q1').removed).toBeNull()
    expect(findQuick(s, { taskId: 'gone' }, 'q1')).toBeNull()
  })
})

describe('addTab spec — 빠른 명령 새 탭', () => {
  it('그 폴더 · 보낼 명령으로 새 pane, 템플릿 시작 명령(command)은 남기지 않는다', () => {
    const s = stateWithTask()
    const out = addTab(s.tasks[0]!, ids('n'), { cwd: '/w/app/web', command: 'npm run dev' })
    const pane = out.panes[out.tabs.at(-1)!.activePaneId]!
    expect(pane).toEqual({ id: pane.id, cwd: '/w/app/web', pendingCommand: 'npm run dev' })
  })
})
