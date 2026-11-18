// 에이전트에게 주는 Taskminal 명령 안내 (58b 대화 pane 의 claude · 63단계 Codex 와 터미널의 claude · codex). 순수.
// 에이전트는 환경 변수(TASKMINAL_PANE_ID · 소켓 · PATH)만 받아서는 `taskminal` 명령이 있는 줄 모른다 —
// 띄울 때 --append-system-prompt 로 그 실행에만 붙인다(사용자 Claude 설정 파일은 건드리지 않는다).
// 명령은 줄 머리(또는 && 뒤)에, 설명은 ` # ` 뒤에 적는다 — tests/unit/agent-guide.test.ts 가 명령마다 shared/cli.ts 해석기에 넣어 본다.
// 매 실행의 시스템 프롬프트에 들어가므로 짧게(열 줄 · 800자 안쪽), 경로 · 비밀값은 넣지 않는다.
const GUIDE = [
  '이 대화는 Taskminal 앱의 일감 안에서 돌아요. 셸에서 아래 명령을 쓸 수 있어요 (PANE · TAB 은 앞 명령의 출력에서 얻은 id).',
  'taskminal task note "다음 할 일 …"   # 이 일감의 메모에 남기기 — 일을 마칠 때',
  'taskminal notify "확인할 것 …"   # 사람에게 알리기 — 사람 확인이 필요할 때',
  'taskminal chat new "맡길 일"   # 새 대화를 만들어 일을 맡기기 — 출력에 그 대화의 pane id',
  'taskminal chat send PANE "이어서 맡길 일"   # 그 대화에 이어 보내기',
  'taskminal chat wait PANE && taskminal chat read PANE   # 그 대화가 멈출 때(턴 끝 · 허락/질문 기다림)까지 기다린 뒤 마지막 답 읽기',
  'taskminal browser tabs "$TASKMINAL_TASK_ID" --json   # 이 일감의 브라우저 탭 — 출력의 selectedTabId 가 TAB',
  'taskminal browser navigate "$TASKMINAL_TASK_ID" --tab TAB --url http://localhost:3000   # 그 탭에서 주소 열기',
  'taskminal browser snapshot "$TASKMINAL_TASK_ID" --tab TAB --json   # 열린 페이지의 글 · 요소 읽기',
  'taskminal help   # 브라우저 누르기 · 채우기 등 나머지 명령과 옵션',
].join('\n')

export function agentGuide(): string {
  return GUIDE
}

// 63단계: 같은 안내를 Codex 와 터미널에서 띄운 claude · codex 에게도.
// codex 는 설정 키 developer_instructions 로 받는다(codex-cli 0.169.0 `codex -c … debug prompt-input` 의 developer 메시지로 확인).
// -c 는 사용자 config.toml 의 같은 키를 덮으므로, 사용자가 그 키를 두었으면 주지 않는다.

/** `codex -c <값>` — TOML 기본 문자열 이스케이프는 JSON 과 같다(\" · \\ · \n) */
export function codexGuideArg(): string {
  return `developer_instructions=${JSON.stringify(GUIDE)}`
}

/** 사용자 codex config.toml 맨 위(첫 [표] 앞)에 developer_instructions 가 있나 — 있으면 덮지 않게 안내를 주지 않는다 */
export function codexHasDeveloperInstructions(toml: string): boolean {
  for (const raw of toml.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) return false
    if (/^developer_instructions\s*=/.test(line)) return true
  }
  return false
}

/**
 * 새 셸에 넣는 안내 변수 — 셸 통합(zsh)의 claude · codex 함수가 그 실행의 인자로만 붙인다.
 * enabled: 설정 '에이전트에게 Taskminal 명령 알려 주기'. codexToml: 사용자 codex config.toml 글(없으면 빈 글).
 */
export function agentGuideEnv(enabled: boolean, codexToml: string): Record<string, string> {
  if (!enabled) return {}
  return { TASKMINAL_AGENT_GUIDE: GUIDE, ...(codexHasDeveloperInstructions(codexToml) ? {} : { TASKMINAL_CODEX_GUIDE: codexGuideArg() }) }
}
