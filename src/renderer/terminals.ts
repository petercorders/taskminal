// 마운트된 xterm 을 paneId 로 찾는 등록부 — 화면 지우기(⌘K)처럼 상태가 아니라 터미널 자체에 하는 명령용.
// TerminalPane 이 마운트 · 해제 때 넣고 뺀다.
export interface TerminalHandle {
  clear(): void
  /** 스크롤 저장용 글 (색 · 줄 포함) */
  serialize(): string
  /** 스크롤 버퍼에서 찾기 글자가 든 줄 (대소문자 무시) — 최근 줄부터 limit 개 */
  search(query: string, limit: number): Array<{ line: number; text: string }>
  /** 그 줄로 스크롤하고 찾기 글자를 선택한다 */
  reveal(line: number, query: string): void
}

export const terminals = new Map<string, TerminalHandle>()
