import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackupStore } from '../../src/main/backup-store'
import { backupName } from '../../src/shared/backup'
import { emptyState } from '../../src/shared/model'

// 실제 임시 폴더로 시험한다 (권한 · rename 은 mock 으로 대신하지 않는다).
let root: string
const SEOUL = () => -540
const NOW = Date.UTC(2026, 10, 11, 3, 0, 0)
const newId = () => 'id'
const backups = () => join(root, 'backups')
const writeState = (fontSize: number) => {
  const s = emptyState()
  s.settings.fontSize = fontSize
  writeFileSync(join(root, 'state.json'), JSON.stringify(s))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'taskminal-backup-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('BackupStore', () => {
  it('state.json 이 없으면 아무것도 만들지 않는다', () => {
    expect(new BackupStore(root, SEOUL).snapshot('start', NOW)).toBeNull()
  })

  it('사본을 0600 · 폴더 0700 으로 만들고, 같은 내용이면 건너뛴다', () => {
    writeState(14)
    const b = new BackupStore(root, SEOUL)
    const name = b.snapshot('start', NOW)
    expect(name).toBe(backupName(NOW, 'start'))
    expect(statSync(backups()).mode & 0o777).toBe(0o700)
    expect(statSync(join(backups(), name as string)).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(backups(), name as string), 'utf8')).toBe(readFileSync(join(root, 'state.json'), 'utf8'))
    expect(b.snapshot('auto', NOW + 1000)).toBeNull()
    expect(b.snapshot('restore', NOW + 1500, true)).toBe(backupName(NOW + 1500, 'restore')) // 사용자가 부른 것은 같아도
    // 새 인스턴스(앱 다시 실행)도 파일에서 마지막 해시를 읽어 건너뛴다
    expect(new BackupStore(root, SEOUL).snapshot('start', NOW + 2000)).toBeNull()
    writeState(15)
    expect(b.snapshot('settings', NOW + 3000)).toBe(backupName(NOW + 3000, 'settings'))
    expect(readdirSync(backups()).filter((f) => f.startsWith('state-'))).toHaveLength(3)
  })

  it('만들 때 보존 규칙으로 오래된 것을 지운다', () => {
    mkdirSync(backups(), { recursive: true })
    const old = backupName(NOW - 40 * 86_400_000, 'auto')
    writeFileSync(join(backups(), old), '{}')
    writeState(14)
    new BackupStore(root, SEOUL).snapshot('start', NOW)
    expect(readdirSync(backups())).toEqual([backupName(NOW, 'start')])
  })

  it('list: 새 것부터 · 일감 수 · 깨진 것은 null', () => {
    mkdirSync(backups(), { recursive: true })
    writeFileSync(join(backups(), backupName(NOW - 1000, 'auto')), JSON.stringify({ ...emptyState(), tasks: [{}, {}] }))
    writeFileSync(join(backups(), backupName(NOW, 'delete')), '{broken')
    writeFileSync(join(backups(), 'notes.txt'), 'x')
    const list = new BackupStore(root, SEOUL).list()
    expect(list.map((e) => [e.reason, e.tasks])).toEqual([
      ['delete', null],
      ['auto', 2],
    ])
  })

  it('read: 이름 모양을 검사한다(경로 탈출) · 깨진 것은 Error', () => {
    mkdirSync(backups(), { recursive: true })
    writeFileSync(join(root, 'secret.json'), JSON.stringify(emptyState()))
    const b = new BackupStore(root, SEOUL)
    expect(b.read('../secret.json', newId)).toBeInstanceOf(Error)
    expect(b.read(42, newId)).toBeInstanceOf(Error)
    const bad = backupName(NOW, 'auto')
    writeFileSync(join(backups(), bad), '{x')
    expect(b.read(bad, newId)).toBeInstanceOf(Error)
  })

  it('latestGood: 새 것부터 읽을 수 있는 첫 백업', () => {
    mkdirSync(backups(), { recursive: true })
    const good = { ...emptyState() }
    good.settings.fontSize = 18
    writeFileSync(join(backups(), backupName(NOW - 5000, 'auto')), JSON.stringify(good))
    writeFileSync(join(backups(), backupName(NOW, 'auto')), '{broken')
    const r = new BackupStore(root, SEOUL).latestGood(newId)
    expect(r?.at).toBe(NOW - 5000)
    expect(r?.state.settings.fontSize).toBe(18)
    rmSync(join(backups(), backupName(NOW - 5000, 'auto')))
    expect(new BackupStore(root, SEOUL).latestGood(newId)).toBeNull()
  })

  it('버전 기록', () => {
    const b = new BackupStore(root, SEOUL)
    expect(b.lastVersion()).toBeNull()
    b.writeVersion('0.1.0')
    expect(b.lastVersion()).toBe('0.1.0')
  })
})
