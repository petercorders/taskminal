import { describe, expect, test } from 'vitest'
import { paneIds } from '../../src/shared/layout'
import {
  addTab,
  closePane,
  closeTab,
  createTask,
  cycleActivePane,
  cycleTab,
  defaultSettings,
  emptyState,
  findPaneTask,
  focusPane,
  markCommandSent,
  normalizeState,
  removeGroup,
  removeStatus,
  renameTab,
  resolveCwd,
  selectTab,
  selectTabAt,
  setTabRatio,
  splitActivePane,
  setPaneCwd,
  tabLabel,
  taskToTemplate,
} from '../../src/shared/model'
import type { AppState, NewTaskInput, Settings, Task, Template } from '../../src/shared/types'

function ids() {
  let n = 0
  return () => `id${++n}`
}

const flutterTemplate: Template = {
  id: 'tpl-flutter',
  name: 'Flutter 작업',
  tabs: [
    {
      title: '개발',
      layout: {
        split: 'right',
        ratio: 0.6,
        a: { pane: { command: 'claude' } },
        b: { split: 'down', a: { pane: { command: 'flutter run', cwd: 'flutter' } }, b: { pane: {} } },
      },
    },
    { title: '로그', layout: { pane: { cwd: '/var/log' } } },
  ],
}

function settingsWith(...templates: Template[]): Settings {
  const s = defaultSettings()
  return { ...s, templates: [...s.templates, ...templates], groups: [{ id: 'g1', name: '찍계부' }] }
}

function input(over: Partial<NewTaskInput> = {}): NewTaskInput {
  return { name: '정산 화면', cwd: '/Users/me/app', templateId: null, statusId: 'doing', groupId: null, color: null, ...over }
}

describe('resolveCwd', () => {
  test('없으면 기준 폴더, 절대 경로는 그대로, 상대 경로는 이어 붙이고 정리', () => {
    expect(resolveCwd('/a/b')).toBe('/a/b')
    expect(resolveCwd('/a/b', '')).toBe('/a/b')
    expect(resolveCwd('/a/b', '/x/y')).toBe('/x/y')
    expect(resolveCwd('/a/b', 'c/d')).toBe('/a/b/c/d')
    expect(resolveCwd('/a/b/', './c/')).toBe('/a/b/c')
    expect(resolveCwd('/a/b', '../c')).toBe('/a/c')
    expect(resolveCwd('/a', '../../..')).toBe('/')
  })

  test('~ 로 시작하는 기준 폴더는 ~ 를 지킨다', () => {
    expect(resolveCwd('~/app', 'flutter')).toBe('~/app/flutter')
    expect(resolveCwd('~/app', '../other')).toBe('~/other')
    expect(resolveCwd('/a', '~/x')).toBe('~/x')
  })
})

describe('defaultSettings', () => {
  test('상태 3개 · 템플릿 3개 · 글자 13 · 셸 null', () => {
    const s = defaultSettings()
    expect(s.statuses.map((x) => x.name)).toEqual(['진행 중', '대기', '완료'])
    expect(s.templates.map((x) => x.name)).toEqual(['기본', 'Claude + 셸', '개발 서버 + 셸'])
    expect(s.fontSize).toBe(13)
    expect(s.shell).toBeNull()
  })
})

describe('createTask', () => {
  test('템플릿 없이 만들면 탭 하나 · pane 하나 · 일감 폴더', () => {
    const t = createTask(input(), defaultSettings(), ids(), 1000)
    expect(t).toMatchObject({ id: 'id1', name: '정산 화면', cwd: '/Users/me/app', statusId: 'doing', groupId: null, createdAt: 1000 })
    expect(t.tabs).toHaveLength(1)
    const [pid] = paneIds(t.tabs[0].layout)
    expect(t.panes[pid]).toEqual({ id: pid, cwd: '/Users/me/app' })
    expect(t.activeTabId).toBe(t.tabs[0].id)
    expect(t.tabs[0].activePaneId).toBe(pid)
  })

  test('템플릿을 펼친다: 탭 · 분할 모양 · pane 폴더 · 시작 명령은 pendingCommand 로', () => {
    const t = createTask(input({ templateId: 'tpl-flutter' }), settingsWith(flutterTemplate), ids(), 0)
    expect(t.tabs.map((x) => x.title)).toEqual(['개발', '로그'])
    const dev = t.tabs[0]
    expect(dev.layout).toMatchObject({ type: 'split', dir: 'right', ratio: 0.6, b: { type: 'split', dir: 'down', ratio: 0.5 } })
    const [p1, p2, p3] = paneIds(dev.layout).map((id) => t.panes[id])
    expect(p1).toMatchObject({ cwd: '/Users/me/app', command: 'claude', pendingCommand: 'claude' })
    expect(p2).toMatchObject({ cwd: '/Users/me/app/flutter', command: 'flutter run', pendingCommand: 'flutter run' })
    expect(p3).toEqual({ id: p3.id, cwd: '/Users/me/app' })
    const [log] = paneIds(t.tabs[1].layout)
    expect(t.panes[log].cwd).toBe('/var/log')
    expect(dev.activePaneId).toBe(p1.id)
    expect(t.activeTabId).toBe(dev.id)
  })

  test('id 가 모두 다르다', () => {
    const t = createTask(input({ templateId: 'tpl-flutter' }), settingsWith(flutterTemplate), ids(), 0)
    const all = [t.id, ...t.tabs.map((x) => x.id), ...Object.keys(t.panes)]
    expect(new Set(all).size).toBe(all.length)
  })

  test('없는 템플릿 · 탭 없는 템플릿 → pane 하나', () => {
    const empty: Template = { id: 'tpl-empty', name: '빈', tabs: [] }
    for (const templateId of ['nope', 'tpl-empty']) {
      const t = createTask(input({ templateId }), settingsWith(empty), ids(), 0)
      expect(t.tabs).toHaveLength(1)
      expect(Object.keys(t.panes)).toHaveLength(1)
    }
  })

  test('없는 상태는 첫 상태, 없는 묶음은 null, 이름 앞뒤 공백 제거 · 빈 이름은 "새 일감"', () => {
    const s = settingsWith()
    expect(createTask(input({ statusId: 'nope', groupId: 'nope' }), s, ids(), 0)).toMatchObject({ statusId: s.statuses[0].id, groupId: null })
    expect(createTask(input({ groupId: 'g1' }), s, ids(), 0).groupId).toBe('g1')
    expect(createTask(input({ name: '  정산  ' }), s, ids(), 0).name).toBe('정산')
    expect(createTask(input({ name: '   ' }), s, ids(), 0).name).toBe('새 일감')
  })

  test('빈 폴더는 ~ 로 — 다시 읽을 때 버려지지 않게', () => {
    const t = createTask(input({ cwd: '  ' }), defaultSettings(), ids(), 0)
    expect(t.cwd).toBe('~')
    expect(Object.values(t.panes)[0].cwd).toBe('~')
    const back = normalizeState(JSON.parse(JSON.stringify({ version: 1, tasks: [t], activeTaskId: t.id, settings: defaultSettings() })), ids())
    expect(back.tasks).toHaveLength(1)
  })
})

function flutterTask(): Task {
  return createTask(input({ templateId: 'tpl-flutter' }), settingsWith(flutterTemplate), ids(), 0)
}

describe('addTab · splitActivePane · markCommandSent', () => {
  test('새 탭은 지금 pane 의 폴더에서 열리고 활성 탭이 된다', () => {
    const t = flutterTask()
    const withCwd = { ...t, panes: { ...t.panes, [t.tabs[0].activePaneId]: { ...t.panes[t.tabs[0].activePaneId], cwd: '/tmp' } } }
    const out = addTab(withCwd, () => 'new')
    expect(out.tabs).toHaveLength(3)
    expect(out.activeTabId).toBe(out.tabs[2].id)
    expect(out.panes[out.tabs[2].activePaneId].cwd).toBe('/tmp')
  })

  test('탭이 없으면 일감 폴더에서 연다', () => {
    const t = { ...flutterTask(), tabs: [], activeTabId: null, panes: {} }
    const out = addTab(t, ids())
    expect(out.panes[out.tabs[0].activePaneId].cwd).toBe('/Users/me/app')
  })

  test('분할: 지금 pane 옆에 같은 폴더의 새 pane, 새 pane 이 활성', () => {
    const t = flutterTask()
    const out = splitActivePane(t, 'down', () => 'n1')
    const tab = out.tabs[0]
    expect(paneIds(tab.layout)).toHaveLength(4)
    expect(tab.activePaneId).toBe('n1')
    expect(out.panes.n1).toEqual({ id: 'n1', cwd: t.panes[t.tabs[0].activePaneId].cwd })
  })

  test('활성 탭이 없거나 활성 pane 이 화면에 없으면 분할은 아무것도 안 한다', () => {
    const t = { ...flutterTask(), activeTabId: null }
    expect(splitActivePane(t, 'right', ids())).toBe(t)
    const u = flutterTask()
    const lost = { ...u, tabs: [{ ...u.tabs[0], activePaneId: 'ghost' }, u.tabs[1]] }
    expect(splitActivePane(lost, 'right', ids())).toBe(lost)
  })

  test('19단계 기록의 ⌥↩: 그 기록 폴더에서 분할 · 실행할 명령(템플릿 command 는 남기지 않음) · 위험 명령은 넣기만', () => {
    const t = flutterTask()
    const run = splitActivePane(t, 'right', () => 'r1', { cwd: '/srv', command: 'npm test' })
    expect(run.panes.r1).toEqual({ id: 'r1', cwd: '/srv', pendingCommand: 'npm test' })
    const ins = splitActivePane(t, 'right', () => 'r2', { cwd: '/srv', command: 'git push', insert: true })
    expect(ins.panes.r2).toEqual({ id: 'r2', cwd: '/srv', pendingCommand: 'git push', pendingInsert: true })
    // 보낸 뒤에는 둘 다 지운다 — 복원 때 다시 넣지 않게
    expect(markCommandSent(ins, 'r2').panes.r2).toEqual({ id: 'r2', cwd: '/srv' })
  })

  test('pendingInsert 는 저장 · 읽기를 거쳐도 남는다', () => {
    const t = splitActivePane(flutterTask(), 'right', () => 'r2', { cwd: '/srv', command: 'git push', insert: true })
    const st = { ...emptyState(), tasks: [t], activeTaskId: t.id }
    expect(normalizeState(JSON.parse(JSON.stringify(st)), ids()).tasks[0]!.panes.r2).toEqual({ id: 'r2', cwd: '/srv', pendingCommand: 'git push', pendingInsert: true })
  })

  test('시작 명령을 보내면 pendingCommand 만 지우고 command 는 남긴다 (템플릿 저장용)', () => {
    const t = flutterTask()
    const pid = t.tabs[0].activePaneId
    const out = markCommandSent(t, pid)
    expect(out.panes[pid].pendingCommand).toBeUndefined()
    expect(out.panes[pid].command).toBe('claude')
    expect(markCommandSent(out, pid)).toBe(out)
  })
})

describe('closePane · closeTab', () => {
  test('pane 을 닫으면 형제가 자리를 차지하고 pane 기록도 지운다', () => {
    const t = flutterTask()
    const [p1, p2] = paneIds(t.tabs[0].layout)
    const out = closePane(t, p2)
    expect(paneIds(out.tabs[0].layout)).not.toContain(p2)
    expect(out.panes[p2]).toBeUndefined()
    expect(out.tabs[0].activePaneId).toBe(p1)
  })

  test('활성 pane 을 닫으면 남은 pane 중 화면 순서 첫 번째가 활성', () => {
    const t = flutterTask()
    const [p1, p2] = paneIds(t.tabs[0].layout)
    expect(closePane(t, p1).tabs[0].activePaneId).toBe(p2)
  })

  test('마지막 pane 을 닫으면 탭이 닫히고, 활성 탭은 오른쪽 이웃 → 없으면 왼쪽', () => {
    let t = addTab(flutterTask(), () => 'p-mid') // 탭: 개발, 로그, 새 탭(활성)
    t = { ...t, activeTabId: t.tabs[1].id }
    const [log] = paneIds(t.tabs[1].layout)
    const out = closePane(t, log)
    expect(out.tabs.map((x) => x.title)).toEqual(['개발', undefined])
    expect(out.activeTabId).toBe(out.tabs[1].id)

    const last = closeTab(out, out.tabs[1].id)
    expect(last.activeTabId).toBe(last.tabs[0].id)
  })

  test('활성이 아닌 탭을 닫으면 활성 탭은 그대로', () => {
    const t = flutterTask()
    const out = closeTab(t, t.tabs[1].id)
    expect(out.activeTabId).toBe(t.tabs[0].id)
    expect(Object.keys(out.panes)).toHaveLength(3)
  })

  test('탭을 모두 닫으면 tabs 는 비고 activeTabId 는 null', () => {
    let t = flutterTask()
    t = closeTab(t, t.tabs[0].id)
    t = closeTab(t, t.tabs[0].id)
    expect(t.tabs).toEqual([])
    expect(t.activeTabId).toBeNull()
    expect(t.panes).toEqual({})
  })

  test('모르는 pane · 탭은 그대로', () => {
    const t = flutterTask()
    expect(closePane(t, 'zz')).toBe(t)
    expect(closeTab(t, 'zz')).toBe(t)
  })
})

describe('selectTab · renameTab · tabLabel', () => {
  test('selectTab: 있는 탭만 활성으로, 없는 id 는 그대로', () => {
    const t = flutterTask()
    expect(selectTab(t, t.tabs[1].id).activeTabId).toBe(t.tabs[1].id)
    expect(selectTab(t, 'zz')).toBe(t)
    // 이미 활성인 탭을 다시 골라도 같은 객체 — 바뀐 것이 없으면 저장하지 않게
    expect(selectTab(t, t.activeTabId!)).toBe(t)
  })

  test('renameTab: 이름이 그대로면 같은 객체 (빈 이름 → 이름 없던 탭 포함)', () => {
    const t = flutterTask()
    expect(renameTab(t, t.tabs[0].id, ' 개발 ')).toBe(t)
    const untitled = renameTab(t, t.tabs[1].id, '')
    expect(renameTab(untitled, untitled.tabs[1].id, '  ')).toBe(untitled)
  })

  test('renameTab: 앞뒤 공백 제거, 빈 이름이면 title 을 지워 기본 이름으로, 없는 탭은 그대로', () => {
    const t = flutterTask()
    const id = t.tabs[0].id
    expect(renameTab(t, id, '  서버  ').tabs[0].title).toBe('서버')
    const cleared = renameTab(t, id, '   ')
    expect(cleared.tabs[0]).not.toHaveProperty('title')
    expect(cleared.tabs[1].title).toBe('로그') // 다른 탭은 그대로
    expect(renameTab(t, 'zz', 'x')).toBe(t)
  })

  test('tabLabel: 이름이 있으면 이름, 없으면 활성 pane 폴더의 끝 이름', () => {
    const t = flutterTask()
    expect(tabLabel(t, t.tabs[0])).toBe('개발')
    const plain = renameTab(t, t.tabs[1].id, '') // 로그 탭: /var/log
    expect(tabLabel(plain, plain.tabs[1])).toBe('log')
    const at = (cwd: string) => {
      const pid = plain.tabs[1].activePaneId
      const u = { ...plain, panes: { ...plain.panes, [pid]: { id: pid, cwd } } }
      return tabLabel(u, u.tabs[1])
    }
    expect(at('~')).toBe('~')
    expect(at('/')).toBe('/')
    expect(at('~/code/app/')).toBe('app')
  })

  test('tabLabel: pane 기록이 없으면 일감 폴더 끝 이름', () => {
    const t = flutterTask()
    const tab = { ...t.tabs[1], title: undefined, activePaneId: 'ghost' }
    expect(tabLabel(t, tab)).toBe('app')
  })
})

describe('taskToTemplate', () => {
  test('탭 · 분할 · 명령을 옮기고, 폴더는 일감 폴더 안이면 상대 경로', () => {
    const tpl = taskToTemplate(flutterTask(), '내 템플릿', () => 'tpl-new')
    expect(tpl).toEqual({
      id: 'tpl-new',
      name: '내 템플릿',
      tabs: [
        {
          title: '개발',
          layout: {
            split: 'right',
            ratio: 0.6,
            a: { pane: { command: 'claude' } },
            b: { split: 'down', ratio: 0.5, a: { pane: { command: 'flutter run', cwd: 'flutter' } }, b: { pane: {} } },
          },
        },
        { title: '로그', layout: { pane: { cwd: '/var/log' } } },
      ],
    })
  })

  test('빈 이름은 "새 템플릿" — 다시 읽을 때 버려지지 않게', () => {
    expect(taskToTemplate(flutterTask(), '  ', () => 't').name).toBe('새 템플릿')
  })

  test("일감 폴더 안의 '~' 라는 폴더는 ./~ 로 저장해 홈 폴더와 헷갈리지 않는다", () => {
    const t = flutterTask()
    const pid = t.tabs[0].activePaneId
    const odd = { ...t, panes: { ...t.panes, [pid]: { ...t.panes[pid], cwd: '/Users/me/app/~/sub' } } }
    const tpl = taskToTemplate(odd, 'x', () => 'tpl-odd')
    const again = createTask(input({ templateId: 'tpl-odd' }), settingsWith(tpl), ids(), 0)
    expect(again.panes[again.tabs[0].activePaneId].cwd).toBe('/Users/me/app/~/sub')
  })

  test('저장한 템플릿으로 다시 만들면 같은 모양이 나온다', () => {
    const tpl = taskToTemplate(flutterTask(), '왕복', () => 'tpl-rt')
    const again = createTask(input({ templateId: 'tpl-rt' }), settingsWith(tpl), ids(), 0)
    const strip = (t: Task) => t.tabs.map((tab) => paneIds(tab.layout).map((id) => ({ cwd: t.panes[id].cwd, command: t.panes[id].command })))
    expect(strip(again)).toEqual(strip(flutterTask()))
  })
})

function stateWithTasks(): AppState {
  const settings = settingsWith(flutterTemplate)
  const a = createTask(input({ name: 'A', statusId: 'wait', groupId: 'g1' }), settings, () => `a${Math.random()}`, 0)
  const b = createTask(input({ name: 'B', statusId: 'doing', groupId: 'g1' }), settings, () => `b${Math.random()}`, 0)
  return { version: 1, tasks: [a, b], activeTaskId: a.id, settings }
}

describe('removeStatus · removeGroup', () => {
  test('상태를 지우면 그 상태의 일감은 남은 첫 상태로', () => {
    const s = stateWithTasks()
    const out = removeStatus(s, 'wait')
    expect(out.settings.statuses.map((x) => x.id)).toEqual(['doing', 'done'])
    expect(out.tasks.map((t) => t.statusId)).toEqual(['doing', 'doing'])
  })

  test('첫 상태를 지우면 다음 상태가 새 첫 상태', () => {
    const out = removeStatus(stateWithTasks(), 'doing')
    expect(out.tasks.map((t) => t.statusId)).toEqual(['wait', 'wait'])
  })

  test('마지막 남은 상태 · 없는 상태는 지우지 않는다', () => {
    let s = stateWithTasks()
    s = removeStatus(removeStatus(s, 'wait'), 'done')
    expect(removeStatus(s, 'doing')).toBe(s)
    expect(removeStatus(s, 'nope')).toBe(s)
  })

  test('묶음을 지우면 일감은 묶음 없음', () => {
    const out = removeGroup(stateWithTasks(), 'g1')
    expect(out.settings.groups).toEqual([])
    expect(out.tasks.map((t) => t.groupId)).toEqual([null, null])
  })
})

describe('normalizeState', () => {
  const gen = ids

  test('객체가 아니면 빈 상태', () => {
    for (const raw of [null, 42, 'x', [], undefined]) {
      expect(normalizeState(raw, gen())).toEqual(emptyState())
    }
  })

  test('정상 상태는 그대로 지나간다', () => {
    const s = stateWithTasks()
    expect(normalizeState(JSON.parse(JSON.stringify(s)), gen())).toEqual(s)
  })

  test('설정: 잘못된 상태 목록 · 글자 크기 · 셸은 기본값, 상태가 비면 기본 상태', () => {
    const out = normalizeState({ settings: { statuses: [], fontSize: 99, shell: 3, groups: [{ id: 1 }, { id: 'g', name: '묶음' }] } }, gen())
    expect(out.settings.statuses).toEqual(defaultSettings().statuses)
    expect(out.settings.fontSize).toBe(13)
    expect(out.settings.shell).toBeNull()
    expect(out.settings.groups).toEqual([{ id: 'g', name: '묶음' }])
    expect(normalizeState({ settings: { fontSize: 8 } }, gen()).settings.fontSize).toBe(8)
    expect(normalizeState({ settings: { fontSize: 32.5 } }, gen()).settings.fontSize).toBe(13)
    expect(normalizeState({ settings: { fontSize: 13.5 } }, gen()).settings.fontSize).toBe(13) // ⌘= ⌘− 는 정수만 만든다
  })

  test('설정: 잘못된 템플릿은 버리고 비율은 0.1~0.9 로', () => {
    const out = normalizeState(
      {
        settings: {
          templates: [
            { id: 't1', name: '좋음', tabs: [{ layout: { split: 'down', ratio: 7, a: { pane: {} }, b: { pane: { command: 'x' } } } }] },
            { id: 't2', name: '나쁨', tabs: [{ layout: { split: 'sideways', a: { pane: {} }, b: { pane: {} } } }] },
            { id: 't3', tabs: [] },
            { id: 't4', name: '명령이 숫자', tabs: [{ layout: { pane: { command: 5 } } }] },
          ],
        },
      },
      gen(),
    )
    expect(out.settings.templates.map((t) => t.id)).toEqual(['t1'])
    expect(out.settings.templates[0].tabs[0].layout).toMatchObject({ ratio: 0.9 })
  })

  test('일감: 필수 칸이 없거나 id 가 겹치면 버린다', () => {
    const s = stateWithTasks()
    const raw = JSON.parse(JSON.stringify(s))
    raw.tasks.push({ ...raw.tasks[0], name: '복제' }, { id: 'x' }, 'junk')
    const out = normalizeState(raw, gen())
    expect(out.tasks.map((t) => t.name)).toEqual(['A', 'B'])
  })

  test('탭: 모르는 pane 을 가리키거나 다른 탭과 pane 이 겹치면 그 탭을 버리고, 안 쓰는 pane 은 지운다', () => {
    const s = stateWithTasks()
    const raw = JSON.parse(JSON.stringify(s))
    const task = raw.tasks[1]
    const goodTab = task.tabs[0]
    const pid = goodTab.activePaneId
    task.tabs.push(
      { id: 'bad1', layout: { type: 'pane', paneId: 'ghost' }, activePaneId: 'ghost' },
      { id: 'bad2', layout: { type: 'pane', paneId: pid }, activePaneId: pid },
      { id: 'bad3', layout: { type: 'split', dir: 'right', ratio: 0.5, a: { type: 'pane', paneId: pid } } },
    )
    task.panes.orphan = { id: 'orphan', cwd: '/x' }
    const out = normalizeState(raw, gen())
    expect(out.tasks[1].tabs.map((t) => t.id)).toEqual([goodTab.id])
    expect(Object.keys(out.tasks[1].panes)).toEqual([pid])
  })

  test('탭: activePaneId 가 틀리면 첫 pane, 같은 탭 안에서 pane 이 겹치면 버린다', () => {
    const s = stateWithTasks()
    const raw = JSON.parse(JSON.stringify(s))
    const task = raw.tasks[0]
    const pid = task.tabs[0].activePaneId
    task.tabs[0].activePaneId = 'nope'
    task.tabs.push({ id: 'dup', layout: { type: 'split', dir: 'down', ratio: 0.5, a: { type: 'pane', paneId: 'q' }, b: { type: 'pane', paneId: 'q' } }, activePaneId: 'q' })
    task.panes.q = { id: 'q', cwd: '/q' }
    const out = normalizeState(raw, gen())
    expect(out.tasks[0].tabs.map((t) => t.id)).toEqual([task.tabs[0].id])
    expect(out.tasks[0].tabs[0].activePaneId).toBe(pid)
  })

  test('pane: cwd 가 없으면 일감 폴더, 명령 칸이 문자열이 아니면 지운다', () => {
    const s = stateWithTasks()
    const raw = JSON.parse(JSON.stringify(s))
    const task = raw.tasks[0]
    const pid = task.tabs[0].activePaneId
    task.panes[pid] = { id: pid, cwd: 5, pendingCommand: 3, command: 'ok' }
    const out = normalizeState(raw, gen())
    expect(out.tasks[0].panes[pid]).toEqual({ id: pid, cwd: task.cwd, command: 'ok' })
  })

  test('참조 고침: activeTabId · activeTaskId · statusId · groupId · color', () => {
    const s = stateWithTasks()
    const raw = JSON.parse(JSON.stringify(s))
    raw.tasks[0].activeTabId = 'nope'
    raw.tasks[0].statusId = 'gone'
    raw.tasks[0].groupId = 'gone'
    raw.tasks[0].color = 7
    raw.activeTaskId = 'nope'
    const out = normalizeState(raw, gen())
    expect(out.tasks[0]).toMatchObject({ activeTabId: out.tasks[0].tabs[0].id, statusId: 'doing', groupId: null, color: null })
    expect(out.activeTaskId).toBe(out.tasks[0].id)
    expect(normalizeState({ ...raw, tasks: [] }, gen()).activeTaskId).toBeNull()
  })

  test('다른 일감과 pane id 가 겹치면 뒤 일감의 그 탭을 버리고, 탭 id 가 겹치면 새 id', () => {
    const s = stateWithTasks()
    const raw = JSON.parse(JSON.stringify(s))
    const [a, b] = raw.tasks
    const aPid = a.tabs[0].activePaneId
    b.tabs.push({ id: a.tabs[0].id, layout: { type: 'pane', paneId: 'own' }, activePaneId: 'own' })
    b.tabs.push({ id: 'steal', layout: { type: 'pane', paneId: aPid }, activePaneId: aPid })
    b.panes.own = { id: 'own', cwd: '/o' }
    b.panes[aPid] = { id: aPid, cwd: '/x' }
    const out = normalizeState(raw, () => 'fresh')
    const tabIds = out.tasks[1].tabs.map((t) => t.id)
    expect(tabIds).not.toContain('steal')
    expect(tabIds).toContain('fresh')
    expect(out.tasks[1].panes[aPid]).toBeUndefined()
  })

  test("pane id '__proto__' 는 버린다 (객체 원형을 바꾸지 않게)", () => {
    const s = stateWithTasks()
    const raw = JSON.parse(JSON.stringify(s))
    raw.tasks[0].tabs.push({ id: 'proto', layout: { type: 'pane', paneId: '__proto__' }, activePaneId: '__proto__' })
    const out = normalizeState(raw, gen())
    expect(out.tasks[0].tabs.map((t) => t.id)).not.toContain('proto')
    expect(Object.getPrototypeOf(out.tasks[0].panes)).toBe(Object.prototype)
  })

  test("저장 파일 panes 에 진짜 '__proto__' 키가 있어도 버린다 (JSON.parse 는 자기 키로 만든다)", () => {
    const s = stateWithTasks()
    const json = JSON.stringify(s).replace('"panes":{', '"panes":{"__proto__":{"id":"__proto__","cwd":"/evil"},')
    const raw = JSON.parse(json)
    raw.tasks[0].tabs.push({ id: 'proto', layout: { type: 'pane', paneId: '__proto__' }, activePaneId: '__proto__' })
    const out = normalizeState(raw, gen())
    expect(out.tasks[0].tabs.map((t) => t.id)).not.toContain('proto')
    expect(Object.getPrototypeOf(out.tasks[0].panes)).toBe(Object.prototype)
  })

  test('템플릿 칸에 항목이 있었는데 하나도 쓸 수 없으면 기본 템플릿, 빈 배열은 그대로', () => {
    expect(normalizeState({ settings: { templates: [{ junk: 1 }] } }, gen()).settings.templates).toEqual(defaultSettings().templates)
    expect(normalizeState({ settings: { templates: [] } }, gen()).settings.templates).toEqual([])
  })

  test('탭이 하나도 안 남은 일감도 살린다 (activeTabId null)', () => {
    const s = stateWithTasks()
    const raw = JSON.parse(JSON.stringify(s))
    raw.tasks[0].tabs = 'broken'
    const out = normalizeState(raw, gen())
    expect(out.tasks[0]).toMatchObject({ name: 'A', tabs: [], activeTabId: null, panes: {} })
  })
})

describe('focusPane · setTabRatio · findPaneTask', () => {
  test('focusPane: 그 pane 이 든 탭을 활성 탭으로, 그 탭의 활성 pane 으로', () => {
    const t = flutterTask() // 개발(p1 · p2 · p3) · 로그(p4), 활성 = 개발의 p1
    const [, p2] = paneIds(t.tabs[0].layout)
    const [log] = paneIds(t.tabs[1].layout)
    const a = focusPane(t, p2)
    expect(a.tabs[0].activePaneId).toBe(p2)
    expect(a.activeTabId).toBe(t.tabs[0].id)
    const b = focusPane(t, log)
    expect(b.activeTabId).toBe(t.tabs[1].id)
    expect(b.tabs[0].activePaneId).toBe(t.tabs[0].activePaneId) // 다른 탭의 활성 pane 은 그대로
  })

  test('focusPane: 이미 활성이면 · 없는 pane 이면 같은 객체', () => {
    const t = flutterTask()
    expect(focusPane(t, t.tabs[0].activePaneId)).toBe(t)
    expect(focusPane(t, 'ghost')).toBe(t)
  })

  test('setTabRatio: 그 탭의 분할 노드 비율만, 0.1~0.9, 틀린 탭 · 같은 값이면 같은 객체', () => {
    const t = flutterTask() // 개발: right 0.6 [p1 | down [p2 / p3]]
    const out = setTabRatio(t, t.tabs[0].id, ['b'], 0.25)
    expect(out.tabs[0].layout).toMatchObject({ ratio: 0.6, b: { ratio: 0.25 } })
    expect(setTabRatio(t, t.tabs[0].id, [], 2).tabs[0].layout).toMatchObject({ ratio: 0.9 })
    expect(setTabRatio(t, 'zz', [], 0.3)).toBe(t)
    expect(setTabRatio(t, t.tabs[0].id, [], 0.6)).toBe(t)
  })

  test('findPaneTask: pane 이 든 일감 id, 없으면 null', () => {
    const s = { ...emptyState(), tasks: [flutterTask()] }
    const pid = s.tasks[0].tabs[1].activePaneId
    expect(findPaneTask(s, pid)).toBe(s.tasks[0].id)
    expect(findPaneTask(s, 'ghost')).toBeNull()
  })
})

describe('selectTabAt · cycleTab · cycleActivePane (단축키)', () => {
  const threeTabs = () => addTab(addTab(flutterTask(), () => `t${Math.random()}`), () => `u${Math.random()}`)

  test('selectTabAt: n번째(1부터), 9 는 마지막, 없는 번호 · 이미 활성이면 같은 객체', () => {
    const t = threeTabs() // 탭 4개, 활성 = 마지막
    expect(selectTabAt(t, 1).activeTabId).toBe(t.tabs[0].id)
    expect(selectTabAt(t, 2).activeTabId).toBe(t.tabs[1].id)
    const first = selectTabAt(t, 1)
    expect(selectTabAt(first, 9).activeTabId).toBe(t.tabs[3].id)
    expect(selectTabAt(first, 8)).toBe(first) // 탭이 4개뿐
    expect(selectTabAt(t, 4)).toBe(t)
  })

  test('cycleTab: 다음 · 이전, 끝에서 돈다, 탭이 하나면 같은 객체', () => {
    const t = threeTabs()
    const first = selectTabAt(t, 1)
    expect(cycleTab(first, 1).activeTabId).toBe(t.tabs[1].id)
    expect(cycleTab(first, -1).activeTabId).toBe(t.tabs[3].id)
    expect(cycleTab(t, 1).activeTabId).toBe(t.tabs[0].id)
    const one = { ...t, tabs: [t.tabs[0]], activeTabId: t.tabs[0].id }
    expect(cycleTab(one, 1)).toBe(one)
  })

  test('cycleActivePane: 활성 탭 안에서 화면 순서대로 돈다, pane 하나면 같은 객체', () => {
    const t = flutterTask() // 개발: p1 | p2 / p3, 활성 p1
    const [p1, p2, p3] = paneIds(t.tabs[0].layout)
    expect(cycleActivePane(t, 1).tabs[0].activePaneId).toBe(p2)
    expect(cycleActivePane(t, -1).tabs[0].activePaneId).toBe(p3)
    expect(cycleActivePane(cycleActivePane(cycleActivePane(t, 1), 1), 1).tabs[0].activePaneId).toBe(p1)
    const log = selectTabAt(t, 2) // 로그 탭은 pane 하나
    expect(cycleActivePane(log, 1)).toBe(log)
  })
})

describe('setPaneCwd (13단계 — 셸 안의 cd 를 따라감)', () => {
  test('바뀐 폴더를 pane 에 적고, 이름 없는 탭의 이름이 따라간다', () => {
    const t = renameTab(flutterTask(), flutterTask().tabs[1].id, '')
    const pid = t.tabs[1].activePaneId
    const u = setPaneCwd(t, pid, '/tmp/한글 폴더')
    expect(u.panes[pid]!.cwd).toBe('/tmp/한글 폴더')
    expect(tabLabel(u, u.tabs[1])).toBe('한글 폴더')
    expect(u.panes).not.toBe(t.panes)
  })

  test('같은 폴더 · 없는 pane · 빈 경로는 같은 객체 (저장하지 않게)', () => {
    const t = flutterTask()
    const pid = t.tabs[0].activePaneId
    expect(setPaneCwd(t, pid, t.panes[pid]!.cwd)).toBe(t)
    expect(setPaneCwd(t, 'ghost', '/tmp')).toBe(t)
    expect(setPaneCwd(t, pid, '')).toBe(t)
  })

  test('시작 명령 · 원래 명령 칸은 그대로 둔다', () => {
    const t = flutterTask()
    const pid = t.tabs[0].activePaneId
    const before = t.panes[pid]!
    const u = setPaneCwd(t, pid, '/tmp')
    expect(u.panes[pid]).toEqual({ ...before, cwd: '/tmp' })
  })
})
