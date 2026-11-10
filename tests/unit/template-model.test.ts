import { describe, expect, it } from 'vitest'
import { paneIds } from '../../src/shared/layout'
import { addTemplate, addTemplateTabs, createTask, defaultSettings, emptyState, renameTemplate, replaceTemplate, tabToTemplate, taskToTemplate, templateIdCount, templateNameError } from '../../src/shared/model'
import type { AppState, Task, Template } from '../../src/shared/types'

function ids(prefix = 'id') {
  let n = 0
  return () => `${prefix}${++n}`
}

const tpl: Template = {
  id: 'tpl-x',
  name: '서버',
  tabs: [
    { title: '서버', layout: { split: 'down', ratio: 0.7, a: { pane: { command: 'npm run dev', cwd: 'web' } }, b: { pane: {} } } },
    { layout: { pane: { command: 'tail -f log' } } },
  ],
}

function task(): Task {
  return createTask({ name: 'A', cwd: '/w/app', templateId: null, statusId: 'doing', groupId: null, color: null }, defaultSettings(), ids('t'), 0)
}

describe('addTemplateTabs (탭 "+ ▾")', () => {
  it('템플릿의 탭을 모두 뒤에 붙이고, 일감 폴더 기준으로 펼치고, 첫 새 탭을 연다', () => {
    const t = task()
    const out = addTemplateTabs(t, tpl, ids('n'))
    expect(out.tabs).toHaveLength(3)
    expect(out.tabs[0]).toBe(t.tabs[0])
    expect(out.activeTabId).toBe(out.tabs[1]!.id)
    expect(out.tabs[1]!.title).toBe('서버')
    const [top, bottom] = paneIds(out.tabs[1]!.layout)
    expect(out.panes[top!]).toMatchObject({ cwd: '/w/app/web', command: 'npm run dev', pendingCommand: 'npm run dev' })
    expect(out.panes[bottom!]).toEqual({ id: bottom, cwd: '/w/app' })
    expect(out.panes[out.tabs[2]!.activePaneId]).toMatchObject({ pendingCommand: 'tail -f log' })
    // 원래 pane 은 그대로
    expect(out.panes[t.tabs[0]!.activePaneId]).toBe(t.panes[t.tabs[0]!.activePaneId])
  })

  it('탭이 없는 템플릿이면 그대로', () => {
    const t = task()
    expect(addTemplateTabs(t, { ...tpl, tabs: [] }, ids())).toBe(t)
  })
})

describe('tabToTemplate (이 탭을 템플릿으로)', () => {
  it('그 탭 하나만, 폴더는 일감 기준 상대 경로, 시작 명령은 원래 명령', () => {
    const t = addTemplateTabs(task(), tpl, ids('n'))
    const out = tabToTemplate(t, t.tabs[1]!.id, ' 내 서버 ', () => 'new')!
    expect(out).toEqual({ id: 'new', name: '내 서버', tabs: [tpl.tabs[0]] })
  })

  it('없는 탭이면 null · 빈 이름은 "새 템플릿"', () => {
    const t = task()
    expect(tabToTemplate(t, 'nope', 'x', () => 'id')).toBeNull()
    expect(tabToTemplate(t, t.tabs[0]!.id, '  ', () => 'id')!.name).toBe('새 템플릿')
  })
})

describe('템플릿 이름 — 저장 파일이 버리는 이름은 어느 길로도 들어가지 않는다', () => {
  it('templateNameError: 빈 이름 · 예약어(앞뒤 공백 포함)', () => {
    expect(templateNameError('A')).toBeNull()
    expect(templateNameError('  ')).toContain('비어')
    for (const n of ['constructor', ' prototype ', '__proto__']) expect(templateNameError(n)).toContain('쓸 수 없')
  })

  it('탭 · 일감 저장 · 이름 바꾸기도 같은 검사', () => {
    const t = task()
    expect(taskToTemplate(t, 'constructor', () => 'id').name).toBe('새 템플릿')
    expect(tabToTemplate(t, t.tabs[0]!.id, '__proto__', () => 'id')!.name).toBe('새 템플릿')
    const s = addTemplate(emptyState(), tpl)
    expect(renameTemplate(s, 'tpl-x', 'prototype')).toBe(s)
  })
})

describe('addTemplate · replaceTemplate', () => {
  const s0: AppState = emptyState()

  it('추가는 끝에, 같은 id 는 무시', () => {
    const s = addTemplate(s0, tpl)
    expect(s.settings.templates.at(-1)).toBe(tpl)
    expect(addTemplate(s, tpl)).toBe(s)
  })

  it('바꾸기: 이름 · 탭을 바꾸고 id · 자리는 그대로, 없는 id 는 그대로', () => {
    const s = addTemplate(s0, tpl)
    // 맨 끝이 아닌 것(첫째)을 바꿔야 "끝으로 옮김" 을 잡는다
    const first = s.settings.templates[0]!.id
    const out = replaceTemplate(s, first, { name: '새 이름', tabs: [{ layout: { pane: {} } }] })
    expect(out.settings.templates.map((t) => t.id)).toEqual(s.settings.templates.map((t) => t.id))
    expect(out.settings.templates[0]).toEqual({ id: first, name: '새 이름', tabs: [{ layout: { pane: {} } }] })
    expect(replaceTemplate(s, 'nope', { name: 'x', tabs: [] })).toBe(s)
  })
})

describe('기본 템플릿', () => {
  it('세 개: 기본 · Claude + 셸 · 개발 서버 + 셸', () => {
    expect(defaultSettings().templates.map((t) => t.id)).toEqual(['tpl-basic', 'tpl-claude', 'tpl-dev'])
  })
})

describe('templateIdCount', () => {
  it('탭 수 + pane 수 = addTemplateTabs 가 묻는 id 수', () => {
    let asked = 0
    addTemplateTabs(task(), tpl, () => `k${++asked}`)
    expect(templateIdCount(tpl)).toBe(asked)
    expect(asked).toBe(5)
  })
})
