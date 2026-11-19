import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INBOX_DAYS, INBOX_MAX, inboxUnread, markInboxRead, mergeInbox, parseInboxEntry, parseInboxRead, pruneInbox, type InboxApi, type InboxEntry } from '../../src/shared/inbox'
import { InboxModel } from '../../src/shared/inbox-model'
import { InboxStore } from '../../src/main/inbox-store'

// 66단계 알림 받은편지함 — 순수 규칙 · 화면 모델(답을 gate 로 늦춰 순서를 뒤집는다) · main 저장소(임시 폴더).
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-19T10:00:00Z')
const entry = (id: string, o: Partial<InboxEntry> = {}): InboxEntry => ({ id, at: NOW - 1000, kind: 'wait', taskId: 'task-a', paneId: 'pane-a', title: '입력을 기다립니다', body: 'A 일감 · Claude · 허락 기다림', read: false, ...o })
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

describe('받은편지함 순수 규칙', () => {
  it('항목 모양 — 다른 종류 · 긴 본문 · 이상한 id 는 버린다', () => {
    expect(parseInboxEntry(entry('n-1'))).toEqual(entry('n-1'))
    expect(parseInboxEntry({ ...entry('n-1'), kind: 'bell' })).toBeNull()
    expect(parseInboxEntry({ ...entry('n-1'), body: 'x'.repeat(2001) })).toBeNull()
    expect(parseInboxEntry({ ...entry('n-1'), id: '../x' })).toBeNull()
    expect(parseInboxEntry({ ...entry('n-1'), paneId: 3 })).toBeNull()
    expect(parseInboxEntry({ ...entry('n-1'), read: 'yes' })).toMatchObject({ read: false })
    expect(parseInboxEntry(null)).toBeNull()
  })
  it('새것부터 · 30일 안 · 300개까지', () => {
    const old = entry('old', { at: NOW - (INBOX_DAYS + 1) * DAY })
    const many = Array.from({ length: INBOX_MAX + 5 }, (_, i) => entry(`m-${i}`, { at: NOW - i }))
    const kept = pruneInbox([old, ...many], NOW)
    expect(kept).toHaveLength(INBOX_MAX)
    expect(kept[0]!.id).toBe('m-0')
    expect(kept.some((e) => e.id === 'old')).toBe(false)
    // 상한과 상관없이 날짜만으로도 버린다
    expect(pruneInbox([old, entry('new')], NOW).map((e) => e.id)).toEqual(['new'])
  })
  it('합치기 — 같은 id 는 하나, 읽음은 어느 쪽이든 읽었으면 읽음', () => {
    const merged = mergeInbox([entry('a', { read: true }), entry('b')], [entry('a'), entry('c', { at: NOW })], NOW)
    expect(merged.map((e) => [e.id, e.read])).toEqual([['c', false], ['a', true], ['b', false]])
  })
  it('읽음 — id 들 · pane 의 그 시각까지 · 모두, 바뀐 것이 없으면 같은 배열', () => {
    const list = [entry('a', { at: NOW - 10 }), entry('b', { at: NOW + 10 }), entry('c', { paneId: 'pane-b' })]
    expect(markInboxRead(list, { paneId: 'pane-a', until: NOW }).map((e) => e.read)).toEqual([true, false, false])
    expect(markInboxRead(list, { ids: ['c'] }).map((e) => e.read)).toEqual([false, false, true])
    expect(inboxUnread(markInboxRead(list, { all: true }))).toBe(0)
    expect(markInboxRead(list, { ids: ['없음'] })).toBe(list)
    expect(parseInboxRead({ ids: ['a', '../b'] })).toBeNull()
    expect(parseInboxRead({ paneId: 'pane-a', until: NOW })).toEqual({ paneId: 'pane-a', until: NOW })
    expect(parseInboxRead({ all: true })).toEqual({ all: true })
    expect(parseInboxRead({ paneId: 'pane-a' })).toBeNull()
  })
})

function gatedApi() {
  let release!: (v: InboxEntry[]) => void
  const api = {
    list: vi.fn(() => new Promise<InboxEntry[]>((r) => { release = r })),
    add: vi.fn(async () => {}),
    read: vi.fn(async () => {}),
    removeTask: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  } satisfies InboxApi
  return { api, release: (v: InboxEntry[]) => release(v) }
}

describe('받은편지함 화면 모델', () => {
  it('처음 읽는 동안 생긴 알림 · 읽음 · 지운 일감은 늦게 온 읽기 답이 덮지 않는다', async () => {
    const { api, release } = gatedApi()
    const m = new InboxModel(api, () => NOW)
    void m.load()
    m.add({ id: 'new-1', kind: 'fail', taskId: 'task-a', paneId: 'pane-a', body: '실패' })
    m.viewed('pane-b')
    m.removeTask('task-gone')
    release([entry('old-b', { paneId: 'pane-b', at: NOW - 5000 }), entry('old-a', { at: NOW - 6000 }), entry('old-gone', { taskId: 'task-gone' })])
    await tick()
    expect(m.entries.map((e) => [e.id, e.read])).toEqual([['new-1', false], ['old-b', true], ['old-a', false]])
    expect(api.add).toHaveBeenCalledTimes(1)
  })
  it('읽는 동안 비우면 읽어 온 옛 목록을 되살리지 않는다', async () => {
    const { api, release } = gatedApi()
    const m = new InboxModel(api, () => NOW)
    void m.load()
    void m.clear()
    release([entry('old')])
    await tick()
    expect(m.entries).toEqual([])
  })
  it('본 pane 의 읽음 표시는 안 읽은 것이 있을 때만 보낸다(볼 때마다 쓰지 않는다)', async () => {
    const { api, release } = gatedApi()
    const m = new InboxModel(api, () => NOW)
    void m.load()
    release([entry('a')])
    await tick()
    m.viewed('pane-b')
    expect(api.read).not.toHaveBeenCalled()
    m.viewed('pane-a')
    m.viewed('pane-a')
    expect(api.read).toHaveBeenCalledTimes(1)
    expect(m.entries[0]!.read).toBe(true)
  })
  it('같은 id 를 두 번 남겨도 한 줄 · 쓰기 실패는 화면을 바꾸지 않고 알린다', async () => {
    const { api, release } = gatedApi()
    const errors: string[] = []
    api.add.mockRejectedValueOnce(new Error('disk'))
    const m = new InboxModel(api, () => NOW, (what) => errors.push(what))
    void m.load()
    release([])
    await tick()
    const n = { id: 'n-1', kind: 'wait' as const, taskId: 'task-a', paneId: 'pane-a', body: 'x' }
    m.add(n)
    m.add(n)
    await tick()
    expect(m.entries).toHaveLength(1)
    expect(m.entries[0]).toMatchObject({ title: '입력을 기다립니다', read: false, at: NOW })
    expect(api.add).toHaveBeenCalledTimes(1)
    expect(errors).toEqual(['add'])
  })
})

describe('받은편지함 main 저장소', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const dir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'tm-inbox-'))); dirs.push(d); return d }

  it('0600 으로 쓰고 · 같은 id 는 한 줄 · 가린 뒤 · 다시 열어도 남는다', async () => {
    const d = dir()
    const file = join(d, 'inbox.json')
    const secret = 'ghp_' + 'a'.repeat(36)
    const s = new InboxStore(file, () => ({}), () => NOW)
    await s.add(entry('a', { body: `토큰 ${secret}` }))
    await s.add(entry('a', { body: '다시 보냄' }))
    await s.add(entry('b', { at: NOW }))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).not.toContain(secret)
    const again = new InboxStore(file, () => ({}), () => NOW)
    expect((await again.list()).map((e) => e.id)).toEqual(['b', 'a'])
    // 다시 보낸 같은 id 는 처음 것의 본문을 바꾸지 않는다
    expect(readFileSync(file, 'utf8')).not.toContain('다시 보냄')
    await expect(s.add({ id: 'x' })).rejects.toThrow()
  })
  it('읽음 · 일감 지우기 · 비우기가 차례대로 파일에 남는다', async () => {
    const file = join(dir(), 'inbox.json')
    const s = new InboxStore(file, () => ({}), () => NOW)
    await Promise.all([s.add(entry('a')), s.add(entry('b', { taskId: 'task-b', paneId: 'pane-b' })), s.read({ paneId: 'pane-a', until: NOW })])
    expect((await new InboxStore(file, () => ({}), () => NOW).list()).map((e) => [e.id, e.read])).toEqual([['a', true], ['b', false]])
    await s.removeTask('task-b')
    expect((await new InboxStore(file, () => ({}), () => NOW).list()).map((e) => e.id)).toEqual(['a'])
    await s.clear()
    expect(await new InboxStore(file, () => ({}), () => NOW).list()).toEqual([])
  })
  it('깨진 파일은 .bak 으로 옮기고 빈 목록 · 모양이 다른 줄만 버린다', async () => {
    const d = dir()
    const file = join(d, 'inbox.json')
    writeFileSync(file, '{깨짐')
    expect(await new InboxStore(file, () => ({}), () => NOW).list()).toEqual([])
    expect(existsSync(`${file}.bak`)).toBe(true)
    writeFileSync(file, JSON.stringify([entry('ok'), { id: 'bad' }]))
    expect((await new InboxStore(file, () => ({}), () => NOW).list()).map((e) => e.id)).toEqual(['ok'])
  })
})
