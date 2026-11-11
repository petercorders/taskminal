// 마운트된 xterm 을 paneId 로 찾는 등록부 — 화면 지우기(⌘K)처럼 상태가 아니라 터미널 자체에 하는 명령용.
// TerminalPane 이 마운트 · 해제 때 넣고 뺀다.
export interface TerminalHandle {
  clear(): void
  /** ⌥⌘→ · ⌥⌘← 다음 · 이전 가린 칸으로 (17단계) — 가린 칸이 없으면 false */
  maskFocus(step: 1 | -1): boolean
  /** 스크롤 버퍼의 줄(접힌 행을 이은 것) — 모든 출력 찾기 (19단계) */
  lines(): Array<{ line: number; text: string }>
  /** 명령 기록 줄의 출력 위치가 아직 버퍼에 있나 */
  hasMarker(id: string): boolean
  /** 그 명령의 출력 첫 줄로 스크롤 — 마커가 사라졌으면 false */
  gotoMarker(id: string): boolean
  /** 입력줄에 넣기(괄호 붙여넣기 — 실행하지 않음) */
  /** 입력줄에 넣기(실행 안 함) — 여러 줄인데 셸이 괄호 붙여넣기를 안 켰으면 넣지 않고 false */
  insert(text: string): boolean
  /** 스크롤 저장용 글 (색 · 줄 포함) */
  serialize(): string
  /** 스크롤 버퍼에서 찾기 글자가 든 줄 (대소문자 무시) — 최근 줄부터 limit 개 */
  search(query: string, limit: number): Array<{ line: number; text: string }>
  /** 그 줄로 스크롤하고 찾기 글자를 선택한다 */
  /** 그 줄(가까운, 찾기 글자가 든 줄)로 스크롤 · 선택. 글자를 못 찾으면 줄 번호로만 스크롤하고 false */
  reveal(line: number, query: string): boolean
  /** ⌘F 찾기 막대 (15d) — 대소문자 무시, 맞은 곳을 칠한다 */
  find: {
    next(query: string, incremental?: boolean): void
    prev(query: string): void
    /** 칠한 것 · 선택 지우기 */
    clear(): void
    /** 결과 수가 바뀔 때 (index -1 = 위치 모름) — 끊는 함수를 돌려준다 */
    onResults(listener: (index: number, count: number) => void): () => void
  }
}

export const terminals = new Map<string, TerminalHandle>()
