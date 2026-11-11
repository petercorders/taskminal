import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HistoryStore } from '../../src/main/history-store'
import { HISTORY_DAYS, HISTORY_MAX, type HistoryEntry } from '../../src/shared/history'
import { maskOf, secretHash } from '../../src/shared/redact'

// 실제 임시 폴더로 시험한다 (권한 · 파일 모양은 mock 으로 대신하지 않는다)
let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'taskminal-history-'))
  dir = join(root, 'history')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const NOW = new Date(2026, 10, 11, 14, 0).getTime()
let seq = 0
const entry = (p: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: `e${++seq}`,
  taskId: 't1',
  paneId: 'p1',
  cmd: 'npm test',
  cwd: '~/a',
  startedAt: NOW - 3000,
  endedAt: NOW - 1000,
  code: 0,
  tail: ['ok'],
  ...p,
})
const ANT = 'sk-ant-api03-' + 'Zk8aB_c-d'.repeat(8)
const lines = (taskId: string) => readFileSync(join(dir, `${taskId}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as HistoryEntry)

describe('HistoryStore (19단계)', () => {
  it('덧붙이고 다시 읽는다 — 폴더 0700 · 파일 0600, 일감마다 파일', async () => {
    const s = new HistoryStore(dir, () => ({}), () => NOW)
    const a = entry()
    const b = entry({ taskId: 't2', cmd: 'ls' })
    expect(await s.append([a, b])).toBe(2)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 't1.jsonl')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 't2.jsonl')).mode & 0o777).toBe(0o600)
    const again = new HistoryStore(dir, () => ({}), () => NOW)
    expect((await again.list()).map((e) => e.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('디스크로 가기 전에 명령 · 폴더 · 꼬리를 가린다 — 가리지 않기로 한 값은 그대로', async () => {
    const allowed = 'hunter2long-value'
    const s = new HistoryStore(dir, () => ({ allow: new Set([secretHash(allowed)]) }), () => NOW)
    await s.append([entry({ cmd: `curl -H "x-api-key: ${ANT}"`, tail: [`key=${ANT}`, `PASSWORD=${allowed}`] })])
    const raw = readFileSync(join(dir, 't1.jsonl'), 'utf8')
    expect(raw).not.toContain(ANT)
    expect(raw).toContain(maskOf('Anthropic 키'))
    expect(raw).toContain(allowed)
  })

  it('이미 있던 파일이 넓은 권한(0644)이어도 덧붙이면 0600 으로', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 't1.jsonl'), JSON.stringify(entry()) + '\n', { mode: 0o644 })
    const s = new HistoryStore(dir, () => ({}), () => NOW)
    await s.append([entry()])
    expect(statSync(join(dir, 't1.jsonl')).mode & 0o777).toBe(0o600)
  })

  it('같은 id 를 다시 보내면(결과 모름 뒤 다시 시도) 한 번만 쓴다', async () => {
    const s = new HistoryStore(dir, () => ({}), () => NOW)
    const a = entry()
    await s.append([a])
    expect(await s.append([a, entry()])).toBe(1)
    const fresh = new HistoryStore(dir, () => ({}), () => NOW)
    expect(await fresh.append([a])).toBe(0) // 새로 띄운 저장소도 파일의 id 를 본다
    expect(lines('t1')).toHaveLength(2)
  })

  it('renderer 값을 믿지 않는다 — 틀린 줄은 버리고 50개 넘는 묶음은 받지 않는다', async () => {
    const s = new HistoryStore(dir, () => ({}), () => NOW)
    expect(await s.append([entry({ taskId: '../../x' }), { nope: 1 }, entry()])).toBe(1)
    expect(await s.append('x')).toBe(0)
    await expect(s.append(Array.from({ length: 51 }, () => entry()))).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['t1.jsonl'])
  })

  it('읽을 때 90일 넘은 것 · 깨진 줄을 버리고 파일을 다시 쓴다', async () => {
    mkdirSync(dir, { recursive: true })
    const old = entry({ startedAt: NOW - (HISTORY_DAYS + 2) * 864e5, endedAt: NOW - (HISTORY_DAYS + 1) * 864e5 })
    const keep = entry()
    writeFileSync(join(dir, 't1.jsonl'), [JSON.stringify(old), '{깨짐', JSON.stringify(keep), ''].join('\n'))
    const s = new HistoryStore(dir, () => ({}), () => NOW)
    expect((await s.list()).map((e) => e.id)).toEqual([keep.id])
    expect(lines('t1').map((e) => e.id)).toEqual([keep.id])
    expect(statSync(join(dir, 't1.jsonl')).mode & 0o777).toBe(0o600)
  })

  it('파일 이름이 다른 일감 · 다른 taskId 줄은 받지 않는다', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 't1.jsonl'), JSON.stringify(entry({ taskId: 't9' })) + '\n')
    writeFileSync(join(dir, 'notes.txt'), 'x')
    const s = new HistoryStore(dir, () => ({}), () => NOW)
    expect(await s.list()).toEqual([])
  })

  it('넘치면 최근 5,000개만 남긴다', async () => {
    const s = new HistoryStore(dir, () => ({}), () => NOW)
    const many = Array.from({ length: HISTORY_MAX + 120 }, (_, i) => entry({ startedAt: NOW - 864e5, endedAt: NOW - 864e5 + i }))
    for (let i = 0; i < many.length; i += 50) await s.append(many.slice(i, i + 50))
    const kept = lines('t1')
    expect(kept.length).toBeLessThanOrEqual(HISTORY_MAX + 100) // 덧붙이기마다 다시 쓰지 않는다 — 상한을 조금 넘으면 그때 자른다
    expect(kept.at(-1)!.id).toBe(many.at(-1)!.id)
    expect((await new HistoryStore(dir, () => ({}), () => NOW).list()).length).toBe(HISTORY_MAX)
  })

  it('하나 지우기 · 일감 지우기 · 모두 지우기 — 없는 것은 조용히', async () => {
    const s = new HistoryStore(dir, () => ({}), () => NOW)
    const a = entry()
    const b = entry()
    const c = entry({ taskId: 't2' })
    await s.append([a, b, c])
    await s.remove('t1', [a.id, 'nope'])
    expect(lines('t1').map((e) => e.id)).toEqual([b.id])
    await s.remove('t1', [b.id])
    await s.remove('zz', [a.id])
    await s.remove('../x', [a.id])
    await s.removeTask('t2')
    await s.removeTask('t2')
    expect((await s.list()).map((e) => e.id)).toEqual([])
    await s.append([entry()])
    await s.clear()
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })

  it('지운 id 를 다시 보내면 다시 쓴다(되돌리기 뒤 · 다른 실행)', async () => {
    const s = new HistoryStore(dir, () => ({}), () => NOW)
    const a = entry()
    await s.append([a])
    await s.remove('t1', [a.id])
    expect(await s.append([a])).toBe(1)
  })
})
