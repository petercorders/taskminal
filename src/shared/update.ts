// 자동 업데이트(18단계)의 순수 규칙 — main 의 Updater 와 화면이 함께 쓴다.
// 받는 곳: GitHub Releases petercorders/taskminal (2026-11-11 사용자 결정, NAS 대신).

/** 확인 주기 · 앱을 연 뒤 첫 확인까지 */
export const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000
export const UPDATE_FIRST_DELAY_MS = 10_000
export const RELEASES_URL = 'https://github.com/petercorders/taskminal/releases'
export const releasePage = (version: string): string => `${RELEASES_URL}/tag/v${version}`

export type UpdateState =
  | 'disabled' // 개발 실행 · dir 패키징본(app-update.yml 없음) — 확인하지 않음
  | 'blocked' // 디스크 이미지 · 쓸 수 없는 폴더에서 실행 중
  | 'idle' // 아직 확인 전
  | 'checking'
  | 'latest'
  | 'available' // 새 버전이 있지만 받기가 꺼져 있음
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'failed'

export interface UpdateView {
  state: UpdateState
  /** 지금 버전 */
  current: string
  /** 새 버전 (available · downloading · downloaded · installing · install 실패) */
  version?: string
  /** 바뀐 것 앞 몇 줄 · 나머지 수 */
  notes?: string[]
  more?: number
  percent?: number
  transferred?: number
  total?: number
  /** 마지막으로 확인한 시각 */
  checkedAt?: number
  /** 사용자 말로 바꾼 이유 */
  error?: string
  during?: 'check' | 'download' | 'install'
  /** 저절로 다시 확인할 시각 */
  nextAt?: number
  /** 건너뛴 버전 — 최신처럼 보이되 설정 줄에 '건너뜀' */
  skipped?: string
  blocked?: BlockedReason
}

/** 'x.y.z(-pre)' 비교 — 숫자 칸을 차례로, 미리 보기는 같은 번호의 정식보다 낮다 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = '', pre = ''] = v.trim().replace(/^v/, '').split('-', 2)
    return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

const MAX_NOTE_LINES = 3
const MAX_NOTE_CHARS = 80
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

/** 바뀐 것(electron-updater releaseNotes: 글 · HTML · 버전별 목록)을 배너용 앞 세 줄로 */
export function noteSummary(notes: unknown): { lines: string[]; more: number } {
  let text = ''
  if (typeof notes === 'string') text = notes
  else if (Array.isArray(notes)) text = notes.map((n) => (n && typeof n === 'object' && typeof (n as { note?: unknown }).note === 'string' ? (n as { note: string }).note : '')).join('\n')
  const plain = text
    .replace(/<\/(li|p|h\d|div)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
  const all = plain
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/^[-*•]\s+/, ''))
    .map((l) => (l.length > MAX_NOTE_CHARS ? `${l.slice(0, MAX_NOTE_CHARS)}…` : l))
  return { lines: all.slice(0, MAX_NOTE_LINES), more: Math.max(0, all.length - MAX_NOTE_LINES) }
}

/** electron-updater · Squirrel 오류를 사용자 말로 (원문은 오류 기록에) */
export function updateErrorText(e: unknown): string {
  if (!(e instanceof Error)) return '알 수 없는 오류예요'
  const raw = (e as { code?: unknown }).code
  const code = typeof raw === 'string' ? raw : ''
  const m = `${code} ${e.message}`
  if (/ENOSPC/.test(m)) return '디스크에 자리가 없어요'
  if (/code ?signature|signature.*(valid|verif)|not signed/i.test(m)) return '서명을 확인할 수 없어요'
  if (/sha512|checksum/i.test(m)) return '받은 파일이 손상됐어요'
  if (/\b40[34]\b/.test(m)) return '받는 곳에 새 버전 정보가 없어요'
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_(CONNECTION|INTERNET|NAME_NOT_RESOLVED|NETWORK|TIMED_OUT)|socket hang up/i.test(m)) return '연결이 끊겼어요'
  return '알 수 없는 오류예요'
}

/** 업데이트를 받을 수 없는 위치 — 디스크 이미지 안(/Volumes) · 쓸 수 없는 폴더 */
/** 업데이트를 받을 수 없는 자리 — dmg: 디스크 이미지 · translocated: 내려받은 zip 을 옮기지 않고 열어 macOS 가 읽기 전용 임시 자리로 옮김(App Translocation) · readonly: 그 밖의 쓸 수 없는 폴더 */
export type BlockedReason = 'dmg' | 'translocated' | 'readonly'
export function blockedReason(exePath: string, writable: boolean): BlockedReason | null {
  if (exePath.startsWith('/Volumes/')) return 'dmg'
  if (exePath.includes('/AppTranslocation/')) return 'translocated'
  return writable ? null : 'readonly'
}
