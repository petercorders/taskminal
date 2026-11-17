// 터미널 pane 에 끌어 놓은 파일 경로를 셸 입력으로 (58c). 순수 함수.
// development-tools 의 commandLine 은 보여 주기용(안 보이는 글자를 \u{…} 로 바꾼다)이라 쓰지 않는다 — 이 값은 실제 셸에 들어간다.

/** 따옴표 없이 넣어도 셸이 글자 그대로 한 낱말로 읽는 글자 — ASCII 만. 그 밖(공백 · 한글 · $ · ~ · = …)은 모두 따옴표로 감싼다 */
const SAFE = /^[A-Za-z0-9_@%+:,./-]+$/
/** 줄바꿈 · ESC · ^C 같은 제어 글자 — 따옴표 안에 있어도 셸이 읽기 전에 줄 편집기 · tty 가 '누른 키' 로 받는다 */
const CONTROL = /[\x00-\x1f\x7f]/

/** 작은따옴표로 감싸고 안의 ' 는 '\'' 로(닫고 · 글자 ' · 다시 연다) */
const quoteWord = (path: string): string => (SAFE.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`)

/** Windows 에서 따옴표 없이 넣어도 되는 글자 */
const WIN_SAFE = /^[A-Za-z0-9_.:\\/-]+$/
/** Windows 에서 큰따옴표로 감싸면 cmd · PowerShell 둘 다 글자 그대로 읽는 글자 — 글자 · 숫자 · 공백과 몇 가지 기호뿐.
 *  $ · % · ` · " · ' · & · ^ · ! 처럼 큰따옴표 안에서도 한쪽 셸이 펼치거나 끊는 글자는 없다 */
const WIN_QUOTABLE = /^[\p{L}\p{N}_.:\\/ ()+,@-]+$/u

/**
 * 경로들을 셸 낱말로 묶어 공백으로 잇는다. 끝에 공백 하나 — 줄바꿈은 붙이지 않는다(넣기만 하고 실행하지 않는다).
 * 제어 글자가 든 경로는 넣지 않고 건너뛴다: 줄바꿈은 따옴표가 열려 있어도 줄 편집기에는 Enter 라, 셸이 아닌 프로그램(REPL · read)이나
 * 입력줄에 이미 열린 따옴표가 있으면 그 자리에서 실행되고, ^C · ESC · ⌫ 는 입력줄을 지우거나 다른 키로 읽힌다 — 따옴표로는 막을 수 없다.
 * 빈 경로(디스크에 없는 파일)도 건너뛴다. 넣을 것이 없으면 ''.
 * windows: cmd · PowerShell 은 작은따옴표 규칙이 달라 큰따옴표만 쓰고, 그 안에서 글자 그대로 읽히는 경로만 넣는다.
 */
export function shellQuotePaths(paths: readonly string[], windows = false): string {
  const words = windows
    ? paths.filter((p) => WIN_QUOTABLE.test(p)).map((p) => (WIN_SAFE.test(p) ? p : `"${p}"`))
    : // \ 가 든 경로도 건너뛴다 — fish 는 작은따옴표 안의 \ 를 탈출 글자로 읽어 따옴표가 안 닫힌다. 어느 셸인지(ssh 너머 포함) 모른다
      paths.filter((p) => p !== '' && !CONTROL.test(p) && !p.includes('\\')).map(quoteWord)
  return words.length > 0 ? `${words.join(' ')} ` : ''
}
