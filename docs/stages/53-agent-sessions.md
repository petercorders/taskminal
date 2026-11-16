# 53단계 — 밖에서 시작한 에이전트 세션 기록 · 이어 하기 (worker A)

계획: `docs/stages/51-55-orca-gap-v3.md` 의 '53' 표와 '공통 계약'. 브랜치 `feat/gap-sessions`(base `feat/orca-gap-v3` d6b0364), worktree `~/orca/workspaces/taskminal/gap-sessions`. 커밋만(push · PR · merge 는 부모).
plan-check: 서버 없음 — 로컬 기록 파일 읽기와 로컬 프로세스(claude · codex)만 쓴다.

## 구현

| 무엇 | 어디 · 어떻게 |
|---|---|
| 해석(순수) | `src/shared/agent-sessions.ts` — `parseClaudeHead` · `parseCodexHead`(줄마다 JSON, 손상 줄은 세고 건너뜀, 앞부분만 읽었으면 마지막 반쪽 줄은 버림) · `isSessionId`(UUID 모양만) · `resumeCommand` · `summarize`(가린 뒤 공백 접기 · 160자) · `filterSessions`(찾기 · 에이전트 · 범위 · 최신순) · `sessionAgo` · `SessionFeed`(옛 응답 버림 · 한 번에 하나 · 안 보일 때 멈춤) · `withDeadline`(15초) |
| 읽기(main) | `src/main/agent-sessions.ts` `AgentSessions` — `~/.claude/projects/*/*.jsonl` · `~/.codex/sessions/**/rollout-*.jsonl`(깊이 4, 링크 폴더 안 따라감) + 추가 계정 `<userData>/accounts/<agent>/<id>/{projects,sessions}`(`accounts.ts` 의 `CLAUDE_CONFIG_DIR` · `CODEX_HOME`). 읽기 전용 · `O_NOFOLLOW` · 파일마다 앞 256KB · 공급자마다 최신 300개(앞부분은 최대 900개 파일까지 봄) · (경로 · mtime · 크기) 캐시 · 목록 읽기는 한 번에 하나(동시 호출은 같은 결과를 기다림) |
| 루트 | `sessionRoots` — 시험용 `TASKMINAL_AGENT_SESSIONS_HOME` 은 `TASKMINAL_USER_DATA` 가 있을 때만. 계정 목록은 읽을 때마다 다시 본다 |
| IPC | `agent-sessions:list` · `agent-sessions:open`(`src/shared/ipc.ts` `IPC.agentSessionsList` · `IPC.agentSessionsOpen`, 처리기 `src/main/workspace-ipc.ts`). open 은 `{agent, id, paneId, how}` 만 받는다 — 경로 없음, main 이 id 로 다시 찾아 앞부분 · 세션 폴더를 다시 확인 |
| 계정 | `Accounts.bindTo` — 새 pane 을 세션의 계정에 묶는다(추가 계정 세션은 그 계정 폴더에서만 resume 된다). 터미널 명령은 `tuiCommand`(추가 계정이면 `env -i … CLAUDE_CONFIG_DIR=…`) 뒤에 `--resume <id>` / `resume <id>` |
| 화면 | `src/renderer/AgentSessionsPanel.tsx` · `src/renderer/agent-sessions.css` — 찾기 · 에이전트 · 범위(이 일감 폴더 / 모두) · 최신순 · 줄 = 요약 · 에이전트(계정) · 폴더 · 상대 시각(30일 넘으면 날짜) · '이 앱에 열림'. 동작 '대화로 이어 하기' · '터미널로 이어 하기' · 열린 대화면 '열린 대화로 가기'. '새로 고침', 30초마다 · 창 포커스 때 다시 읽기, 건너뛴 기록 수 표시 |
| 진입 | ⌘P '에이전트 세션'(`src/shared/keymap.ts` `agent-sessions`, 키 없음) · 메뉴 보기 › 에이전트 세션(`src/main/menu.ts`) · 작업 도구 줄 단추 · 좁은 창 '작업 도구 선택' |
| 상태 | `chat/resume-tab`(`src/renderer/store.ts`) → `addResumedChatTab`(`src/shared/model.ts`): 새 탭 대화 pane `{agent, sessionId}`, cwd = 세션 폴더, 탭 제목 = 요약 앞 40자. 터미널은 기존 `tab/add` spec `{cwd, command}`(pendingCommand) |
| App | `src/renderer/App.tsx` `resumeAgentSession` — 이미 열린 대화면 이동 → 일감을 id 로 다시 찾음 → main open(15초 한도) → 답의 paneId 가 내 것인지 · 그 사이 열렸는지 · 일감이 남았는지 다시 확인 → 탭. 성공 뒤 같은 세션 열쇠를 1초 더 잡아 상태가 그려지기 전 두 번째 요청을 막는다 |

### 실제 형식 (개발 환경, 2026-11-16 — 키 이름 · type 값만 보고 맞춤, 글은 보지 않음)
- Claude: 파일 이름 = session id(UUID). 줄 type 은 `user` · `assistant` · `attachment` · `session-owner` · `last-prompt` · `ai-title` · `custom-title` · `queue-operation` 등 20여 종. `user` 줄에 `cwd` · `timestamp` · `message.content`(문자열 또는 `text` · `image` · `tool_result` 배열) · `isMeta`. 슬래시 명령은 `<command-message>` · `<command-name>` · `<command-args>` 태그 글.
- Codex: 첫 줄 `session_meta.payload.{id, cwd, timestamp, source}`. 사용자 글은 `response_item` `message` role `user` 의 `input_text`. 앞쪽 사용자 글은 `<environment_context>` · `# AGENTS.md instructions` 주입. **한 파일에 `session_meta` 가 여럿**(하위 에이전트) 있고, 파일의 약 3/4 은 첫 `session_meta.source` 가 `{subagent: …}` 인 하위 에이전트 기록이다.
- 해석 규칙: 주입 블록(`<tag>…</tag>`)은 걷어 낸 나머지, 인자가 있는 슬래시 명령은 '이름 인자', 첫 사용자 글이 앞 256KB 에 없으면 사용자 제목 > 자동 제목 > 마지막 프롬프트 > 인자 없는 명령. cwd 가 없으면 세션이 아님(건너뜀 수에 셈). Codex 하위 에이전트는 목록에서 빼고 따로 셈.

## 공통 계약 → 시험

| 계약 | 이 기능에서 | 시험 |
|---|---|---|
| 늦게 도착하는 옛 응답 | `SessionFeed` 세대 번호 — 도는 중 새 요청이 오면 끝난 옛 응답은 버림 · 닫은 뒤 응답 버림 | 단위 'SessionFeed — 느린 첫 요청 뒤 둘째 요청' · '안 보일 때 … 닫은 뒤 응답은 버린다' |
| 부수 요청 · 한 번에 하나 | renderer: 도는 중 요청 3번 → 동시 1 · 끝난 뒤 한 번 더. main: `list()` 동시 호출은 같은 결과 | 단위 '느린 읽기 중 요청 3번 → 동시에 도는 읽기 1' · main '읽기는 한 번에 하나' |
| 안 보일 때 갱신 멈춤 | `visibilitychange` → `setVisible(false)` 동안 요청은 미뤘다가 보이면 한 번. 패널을 닫으면 `dispose` | 단위 '안 보일 때는 읽지 않고, 다시 보이면 한 번' |
| 처음 한 번만 읽는 값 | 계정 목록 · 가리기 설정은 목록마다 지금 값(캐시는 원문 조각만, 가리기는 매번) | main '가린 뒤 160자 · … 설정을 바꾸면 다음 목록에 바로' |
| 이중 입력(같은 프레임 두 번) | 패널 ref · App 열쇠 · main `target` 합치기(첫 요청의 pane 만, renderer 는 paneId 가 다르면 안 만듦) | e2e '… 같은 프레임 두 번에도 탭 하나' · main '같은 세션을 같은 프레임에 두 번' |
| 연 뒤 대상이 사라짐 | 일감: 패널이 남아 '연 일감이 사라졌어요' · 단추 끔, 진행 중 요청은 답 뒤 id 로 다시 찾아 막음. 세션: main 이 id 로 다시 찾다 '찾지 못했어요' · 폴더 없으면 '세션 폴더가 없어요' | e2e '패널을 연 뒤 그 일감이 사라지면 …' · e2e 터미널 시험의 폴더 없음 · 사라진 기록 · main 두 시험 |
| 중간 단계 실패 · 다시 시도 | 대화 pane 은 첫 보내기 때 `--resume`. 실패하면 기존 대화 띠의 '다시 시도'가 resume 부터(탭은 그대로). 패널 단계 실패(15초 · 폴더 없음)는 탭을 만들기 전이라 줄 안 '다시 시도'가 open 부터 | e2e 'resume 도중 실패 → … 탭을 또 만들지 않는다' |
| 붙는 중 15초 | 줄에 '연결하는 중…' · `withDeadline` 15초 뒤 오류 · 다시 시도, 늦게 온 답은 버려 탭을 만들지 않음. 목록 읽기도 15초 한도, 실패하면 마지막 목록과 받은 시각을 남김 | 단위 'withDeadline — 한도가 지나면 오류, 늦게 온 응답은 무시' |
| 앱 종료 4경로 | main 은 읽기 전용 · 조회만 — 앱 종료 · 창 닫기 · 새로 고침 · 렌더러 충돌 뒤 남는 프로세스 · 파일 없음. 만든 탭은 상태(state.json)로 복원되고 대화 pane 은 sessionId 로 다시 resume. 계정 묶기는 pane 을 만들기 전에 저장돼, 탭을 못 만들면 쓰이지 않는 묶기 한 줄이 남는다(무해 · 상한 20000) | — (실행 안 함) |

## 시험

- 단위 `tests/unit/agent-sessions.test.ts` 19개 · `tests/unit/agent-sessions-main.test.ts` 14개 — 시험 먼저: 모듈 없음 빨강 확인 뒤 구현. 뒤에 넣은 '30일 넘으면 날짜' · '슬래시 명령 · 주입 블록' · '제목 대신' 도 빨강 확인 뒤 구현.
- 기존 `tests/unit/menu.test.ts` 의 '키 없는 메뉴 항목' 목록에 `agent-sessions` 를 더했다(새 메뉴 항목).
- e2e `tests/e2e/agent-sessions.spec.ts` 5개 — 가짜 홈의 직접 만든 가짜 기록, 가짜 claude(`tests/fixtures/fake-claude.mjs`)로 `--resume` · cwd, 가짜 TUI 스크립트로 터미널 시작 명령. 패널 글자 12px 이상 · 대비 4.5 이상을 readability.spec 과 같은 셈으로 본다. 좁은 창(320px 확대 200%) 넘침 · Esc 닫기 · 키보드 Tab 으로 첫 줄 단추까지.
- 스크린샷 `test-results/agent-sessions.png` · `test-results/agent-sessions-small.png` 직접 열어 봄 — 넘침 없음, 처음엔 아주 오래된 기록이 '20726일 전' 으로 보여 30일이 넘으면 날짜로 고침.

### 마지막 검증 (2026-11-16, 종료 코드 그대로)

| 명령 | 종료 | 결과 |
|---|---|---|
| `npm run typecheck` | 0 | — |
| `node ~/.claude/skills/harness-engineering/stacks/electron/templates/tool/check-boundaries.mjs` | 0 | — |
| `npx vitest run` | 0 | 파일 105 · 시험 1259 통과 |
| `npm run build && npx playwright test tests/e2e/agent-sessions.spec.ts tests/e2e/palette.spec.ts tests/e2e/readability.spec.ts tests/e2e/layout-align.spec.ts --reporter=line` | 0 · 0 | 28 통과 |
| `npx playwright test tests/e2e/workspace-tools.spec.ts tests/e2e/layout-ux.spec.ts --reporter=line` (작업 도구 줄에 단추를 더해서 추가로) | 0 | 13 통과 |
| `doc-refs-check.py docs/stages/53-agent-sessions.md` | 0 | 코드 칸 106개 |

## 변이 확인

목록 5개(단위 4 · e2e 1), `mutation-check.sh --batch`. 22초 + 다시 1개 11초.

| 변이 | 결과 |
|---|---|
| `isSessionId` 를 '빈 글이 아니면' 으로 | 잡음 |
| 앞 256KB 상한(`Buffer.alloc(Math.min(HEAD_BYTES, …))`) 제거 | 잡음 |
| `SessionFeed` 세대 비교 제거(옛 응답 버림) | 잡음 |
| main `target` 합치기(`if (running) return running`) 끔 | 잡음 |
| App `findSessionPane` 이 같은 세션을 못 찾게 | 처음 **못 잡음** — 시험이 1초 열쇠 안에 다시 눌러 '아무것도 안 함' 도 통과였다. 다른 일감(B)에서 패널을 열어 A 의 대화로 이동하는지 적극 확인하도록 시험을 고친 뒤 **잡음** |

모두 원복 확인(변이 원문 5줄 그대로 · 변이 글 0).

## 실제 파일 해석 결과 (개발 환경, 2026-11-16 · 읽기 전용 · 글은 출력 안 함 · 스크립트 scratchpad `s53/measure.ts`)

공개 저장소라 기록 개수는 적지 않고 비율 · 범위로만 남긴다(기록 백여 개 규모).

| | 하위 에이전트(뺌) | 실패(세션 아님 · 읽기 오류) | 손상 줄 | 앞 256KB 로 잘림 | 빈 요약 | 해석 시간 |
|---|---|---|---|---|---|---|
| Claude | 없음 | 몇 % | 0 | 대부분 | 약 5% — 고치기 전 약 20% | 수십 ms |
| Codex | 약 3/4 | 0 | 0 | 대부분 | 0 | 100ms 안 |

`AgentSessions.list()`(기본 계정 루트): 처음 0.1초 남짓 · 캐시 뒤 수 ms. Claude 실패는 앞 256KB 에 cwd 가 있는 줄이 없는 기록이다.

## 계획과 다르게 한 것

- Codex 하위 에이전트 기록(첫 `session_meta.source` 가 `{subagent}`)은 목록에서 빼고 수만 센다 — 계획엔 없음. 실제 기록의 약 3/4 이라 목록이 하위 작업으로 덮였다.
- 첫 사용자 글이 없을 때 제목(`custom-title` · `ai-title`) · `last-prompt` · 인자 없는 명령으로 대신한다 — 계획은 '첫 사용자 글'. 실제 빈 요약이 약 20% 였다.
- '연결하는 중 15초' 는 패널의 이어 하기 요청(main 이 id 로 다시 찾고 폴더 확인)에 걸었다. 대화 pane 의 실제 resume 은 첫 보내기 때 일어나 기존 대화 띠의 상태 · 오류를 그대로 쓴다(대화 pane 자체의 15초 한도는 새로 넣지 않음).
- 15초 한도 · 옛 응답 · 안 보일 때 멈춤은 e2e 가 아니라 단위 시험으로 본다(main 을 멈추게 하는 시험용 훅을 넣지 않으려고).
- 이 패널은 `closeDialogs` 로 닫지 않는다 — 기존 일감 지우기 · 보관이 `closeDialogs` 를 불러 패널이 사라지면 '연 뒤 일감이 사라지면 막고 안내' 를 할 수 없어서.
- 터미널로 이어 한 세션은 '이 앱에 열림' 으로 세지 않는다(터미널 pane 에는 sessionId 가 없다) — 같은 세션을 터미널로 두 번 열 수 있다. 같은 프레임 두 번만 막는다.
- (리뷰 고침, 2026-11-16) 기본 계정 루트는 앱 프로세스의 `CLAUDE_CONFIG_DIR` · `CODEX_HOME` 을 따르고, 없으면 `~/.claude` · `~/.codex` 다(처음엔 늘 `~/.claude` · `~/.codex` 였다).

## 미검증 · 하지 않은 것

- 실제 claude · codex 로 resume 해 보지 않음(가짜 claude · 가짜 TUI 만). 특히 추가 계정 세션의 `env -i … resume` 과 Codex 대화 pane 의 `thread/resume` 은 실제 대조 안 함.
- VoiceOver · IME · 라이트 테마 대비는 직접 보지 않음(대비 셈은 어두운 테마 기본값에서만).
- 매우 많은 기록(수천 개)에서의 시간은 재지 않음 — 개발 환경은 백여 개.
- 전체 검사 `full-check.sh` 는 돌리지 않음(지시된 명령만) — 부모가 합친 뒤 돌린다.
