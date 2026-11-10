import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StateFile } from '../../src/main/state-file'
import { emptyState } from '../../src/shared/model'

// 실제 임시 폴더로 시험한다 (파일 · rename 동작은 mock 으로 대신하지 않는다).
let dir: string
let n = 0
const newId = () => `id${++n}`
const statePath = () => join(dir, 'state.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'taskminal-state-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('StateFile', () => {
  it('파일이 없으면 빈 상태 · 안내 없음', () => {
    expect(new StateFile(dir, newId).load()).toEqual({ state: emptyState(), readOnly: false, notice: null })
  })

  it('저장하면 다시 읽을 수 있고 임시 파일이 남지 않는다', () => {
    const f = new StateFile(dir, newId)
    f.load()
    const s = { ...emptyState(), activeTaskId: null }
    s.settings.fontSize = 17
    f.save(s)
    expect(readdirSync(dir)).toEqual(['state.json'])
    expect(new StateFile(dir, newId).load().state.settings.fontSize).toBe(17)
  })

  it('손상 파일은 .bak 으로 옮겨 원본 그대로 남기고, 기본값을 써서 다음엔 다시 백업하지 않는다', () => {
    writeFileSync(statePath(), '{nope')
    const r = new StateFile(dir, newId).load()
    expect(r).toMatchObject({ readOnly: false, notice: 'corrupt' })
    const baks = readdirSync(dir).filter((f) => f.endsWith('.bak'))
    expect(baks).toHaveLength(1)
    expect(readFileSync(join(dir, baks[0]!), 'utf8')).toBe('{nope')
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual(emptyState())
    // 다음 실행은 정상 파일
    expect(new StateFile(dir, newId).load().notice).toBeNull()
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toHaveLength(1)
  })

  it('더 새 버전 파일은 읽기 전용 — save 해도 바이트 그대로', () => {
    const original = '{"version":2,"tasks":[{"id":"t","newField":true}],"future":1}'
    writeFileSync(statePath(), original)
    const f = new StateFile(dir, newId)
    expect(f.load()).toEqual({ state: emptyState(), readOnly: true, notice: 'newer' })
    f.save(emptyState())
    expect(readFileSync(statePath(), 'utf8')).toBe(original)
    expect(readdirSync(dir)).toEqual(['state.json'])
  })

  it('load 전에는 저장하지 않는다 (아직 모르는 파일을 덮지 않게)', () => {
    const original = '{"version":2}'
    writeFileSync(statePath(), original)
    new StateFile(dir, newId).save(emptyState())
    expect(readFileSync(statePath(), 'utf8')).toBe(original)
  })
})
