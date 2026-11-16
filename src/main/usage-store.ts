// 52단계: 계정별 Claude 한도 마지막 값 — `<userData>/usage.json`(0600, tmp → rename). 더 새 값만 받고, 보이는 값이 바뀔 때만 쓰고 알린다.
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { crossedDanger, mergeUsage, normalizeUsageMap, type UsageMap, type UsageSnapshot, type UsageWindowKey } from '../shared/usage'

export interface UsageCrossed {
  account: string
  key: UsageWindowKey
  used: number
  resetsAt: number
}

export class UsageStore {
  private map: UsageMap = {}

  constructor(
    private readonly file: string,
    private readonly onChange: (map: UsageMap, crossed: UsageCrossed[]) => void,
    private readonly now: () => number = Date.now,
  ) {
    try {
      this.map = normalizeUsageMap(JSON.parse(readFileSync(file, 'utf8').slice(0, 1_000_000)))
    } catch {
      this.map = {} // 없거나 깨졌으면 빈 값 — 다음 값이 오면 새로 쓴다
    }
  }

  get(): UsageMap {
    return this.map
  }

  /** 받았으면 true. 늦게 온 옛 값 · 같은 값은 false(저장 · 알림 없음). */
  put(account: string, snap: UsageSnapshot): boolean {
    const prev = this.map[account]
    const next = mergeUsage(prev, snap, this.now())
    if (!next) return false
    this.map = { ...this.map, [account]: next }
    try {
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.map), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
    } catch {
      /* 디스크에 못 써도 이번 실행 화면은 맞다 */
    }
    const crossed = crossedDanger(prev, next).map((key) => ({ account, key, used: next[key]!.used, resetsAt: next[key]!.resetsAt }))
    this.onChange(this.map, crossed)
    return true
  }
}

const UUID = /^[a-f0-9-]{36}$/
/** CLAUDE_CONFIG_DIR → 계정 id. 앱이 만든 추가 계정 폴더(`<accounts>/claude/<uuid>`)면 그 id, 아니면 기본 계정. */
export function claudeAccountId(configDir: string | undefined, accountsRoot: string): string {
  if (!configDir) return 'default-claude'
  const dir = resolve(configDir)
  const id = basename(dir)
  return dirname(dir) === resolve(accountsRoot, 'claude') && UUID.test(id) ? id : 'default-claude'
}
