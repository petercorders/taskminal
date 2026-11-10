// 스크롤 되살리기 (13단계) — 순수 함수. 저장 · 읽기는 main(ScrollbackStore), 화면은 TerminalPane.

/** 저장할 때 담는 줄 수 상한 — 설정의 스크롤 줄 수가 더 커도 이만큼만 (파일 크기 · 저장 시간) */
export const SAVE_LINES_MAX = 5000

export const saveLines = (scrollback: number): number => Math.max(0, Math.min(scrollback, SAVE_LINES_MAX))

const pad = (n: number) => String(n).padStart(2, '0')

/** 되살린 글 뒤에 붙이는 흐린 줄: `── 이전 세션 · 11-10 20:31 ──` (저장한 시각, 이 Mac 시간대) */
export function restoreBanner(savedAt: number): string {
  const d = new Date(savedAt)
  const when = Number.isFinite(d.getTime()) ? ` · ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''
  // 앞 글이 어떤 색 · 모드로 끝났든 지우고(0m), 새 줄에서 시작한다
  return `\x1b[0m\r\n\x1b[2m── 이전 세션${when} ──\x1b[0m\r\n`
}
