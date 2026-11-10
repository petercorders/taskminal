// 마운트된 xterm 을 paneId 로 찾는 등록부 — 화면 지우기(⌘K)처럼 상태가 아니라 터미널 자체에 하는 명령용.
// TerminalPane 이 마운트 · 해제 때 넣고 뺀다.
export interface TerminalHandle {
  clear(): void
}

export const terminals = new Map<string, TerminalHandle>()
