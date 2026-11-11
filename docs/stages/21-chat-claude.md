# 21단계 — 대화 1 (Claude) + 사이드바 흐름 보기

`docs/plan.md` 21 줄: 사이드바 개편(`docs/design-gaps.md` 4) · pane 종류 '대화' · 공통 이벤트 모양 · Claude 어댑터(stream-json · 허락 카드 · 질문 카드) · session_id 저장 → 이어 하기 · 터미널(TUI) 전환 · 허락 방식(처음 '확인', 바꾸면 유지) · 상태/사용량 이벤트 · 빈/실패/로그인/한도.
verify: 단위(이벤트 변환) + e2e(가짜 claude 실행 파일로) — 글 · 도구 줄 · 허락 카드 ↩/Esc · 재시작 뒤 같은 세션 · 허락 방식이 재시작 뒤 유지.
보드: Chat(대화) · Sidebar(사이드바). 브랜치 `stage-21-chat-claude`. 커밋은 21a 대화 → 21b 사이드바 로 나눈다.

plan-check: 서버 없음 — 앱은 로컬 claude 프로세스(stdin/stdout)와 로컬 파일에만 쓴다. API 호출은 claude CLI 몫

## 0. 스파이크 결과 (2026-11-11, claude 2.1.322, haiku, 임시 폴더 · `--setting-sources project`)

저장: `tests/fixtures/claude/*.jsonl` (경로 · 세션 id 를 짧게 바꾼 사본).

| 무엇 | 실제 모양 |
|---|---|
| 띄우기 | `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode <m> [--resume <id>]` — 한 프로세스가 턴 사이에도 살아 stdin 을 기다린다 |
| 보내기 | stdin 한 줄 `{"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]}}` |
| 시작 | `{"type":"system","subtype":"init","session_id","model","permissionMode",…}` |
| 글 · 도구 | `{"type":"assistant","message":{"content":[{"type":"text"}|{"type":"tool_use","id","name","input"}]}}` · 결과는 `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id","content","is_error"}]}}` |
| 허락 | `{"type":"control_request","request_id","request":{"subtype":"can_use_tool","tool_name","input","description","permission_suggestions","blocked_path"?}}` → 답 `{"type":"control_response","response":{"subtype":"success","request_id","response":{"behavior":"allow","updatedInput":…}|{"behavior":"deny","message":…}}}` |
| 질문 | 같은 `can_use_tool` 에 `tool_name:"AskUserQuestion"` · `input.questions[{question,header,options[{label,description}],multiSelect}]` · `requires_user_interaction:true` → 답은 allow + `updatedInput` 에 `answers:{질문:고른 label}` (실제로 모델이 "Red" 로 받음) |
| 멈춤 | stdin `{"type":"control_request","request_id","request":{"subtype":"interrupt"}}` → `control_response` + `result` (`subtype:"error_during_execution"`, `terminal_reason:"aborted_streaming"`) |
| 턴 끝 | `{"type":"result","subtype":"success","is_error":false,"result","session_id","duration_ms","total_cost_usd","usage","modelUsage{…contextWindow}"}` |
| 로그인 없음 | `assistant`(model `<synthetic>`, `error:"authentication_failed"`, 글 `Not logged in · Please run /login`) + `result` `is_error:true` · `terminal_reason:"api_error"` (빈 `CLAUDE_CONFIG_DIR` 로 재현) |
| 한도 | `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"|…,"resetsAt"(초),"rateLimitType":"five_hour",…}}` — 거절 모양은 재현 못 함 → `status !== 'allowed'` 를 한도로, 그 턴의 `result.is_error` 와 함께 띠를 보인다(미확인으로 적음) |
| 이어 하기 | `--resume <id>` 는 같은 session_id 를 쓰고 앞 대화를 stdout 으로 **다시 내보내지 않는다** → 화면에 보일 앞 대화는 앱이 따로 저장해야 한다 |

전제 변경: 보드 '이렇게 연결합니다 2' 의 "앱 MCP 도구로 허락" 대신 `--permission-prompt-tool stdio`(SDK 호스트 방식) — MCP 서버가 필요 없다.

## 1. 범위 — 21a 대화

### 이렇게 만든다 (보드 → 할 일)
| 보드 | 할 일 |
|---|---|
| pane 의 새 종류 '대화' | `Pane.kind?: 'chat'` · `Pane.chat?: { agent: 'claude', sessionId?: string }`. 탭 + 메뉴 · ⌘P '새 대화 (Claude)' · '대화로 오른쪽 나누기' |
| 머리: 에이전트 배지 · 폴더 · 상태 칩 · 경과 | `ChatPane` 머리 — 'Claude' 배지 · 폴더 · 상태(○ 새 대화 / ● 실행 중 · 경과 / ● 입력 기다림 · 허락·질문 / ✓ 끝남 · 걸린 시간 / ✕ 실패 / ■ 멈춤(내가 멈춤)) · [터미널 ⇧⌘J] |
| 도구 실행은 한 줄로 접기 | 한 턴의 도구들을 한 묶음 줄 '도구 N번 · Bash 2 · Read 1' + 상태, 누르면 펼쳐 도구마다 한 줄(이름 · 요약 · ✓/✕) |
| 허락 카드 ↩ / ⌥↩ / Esc | '허락이 필요해요 · <도구 · 이유>' + 명령/파일 · [허락 ↩] [이 명령만 늘 허락 ⌥↩](이 대화 동안) · [거절하고 다른 방법 말하기 Esc](입력창에 포커스, 거절 이유 = 그 뒤 쓴 글 또는 기본 문구). 위험 명령(`danger.ts` · 폴더 밖 경로)은 ⌥↩ 를 숨기고 안내 줄 |
| 질문 카드 1~9 · ↩ | 질문 · 선택지(1~9 키) · 고른 것 강조 · ↩ 보내기 · '직접 써도 돼요'(입력창 글을 답으로) |
| 처음 화면 | 'Claude 와 대화를 시작해요' · 폴더 안내 · 예시 3개(누르면 보냄) · 아래 '⌘P 새 대화 (Claude)' 안내 |
| 실패 띠 | '작업이 실패했어요 · 걸린 시간' + [다시 시도 ↩](마지막 보낸 글 다시) · [터미널로 열기 ⇧⌘J] · 원인 코드 괄호 |
| 로그인 · 한도 · 설치 띠 | CLI 없음(설치 명령 복사) · 로그인 필요([터미널 열기] = 같은 폴더 새 탭에서 `claude` → 사용자가 /login) · 한도(풀리는 시각) |
| 입력창 | ↩ 보내기 · ⇧↩ 줄바꿈 · ⌘. 멈춤 · 한글 조합 중 ↩ 무시 · 허락 칩 '허락: 매번 묻기 ▾ · 저장됨' · 대화 창 % (`modelUsage.contextWindow` 대비 `usage` 입력 합) |
| 허락 방식 | 앱 설정 `chatPermission: 'ask' | 'edits' | 'auto'`(처음 'ask'). 바꾸면 저장 → 새 대화 · 재시작 뒤에도 유지. 자동이면 칩 노랑 + 머리 '자동'. 사용자 Claude 설정 파일은 건드리지 않는다(CLI 인자 `--permission-mode` 로만) |
| session_id 저장 → 이어 하기 | init 의 session_id 를 `pane.chat.sessionId` 에 저장. 재시작 뒤 다음 보내기는 `--resume <id>` |
| 터미널 전환 ⇧⌘J | 대화 pane 을 같은 자리의 터미널 pane 으로 바꾸고 `claude --resume <id>`(id 없으면 `claude`) 를 시작 명령으로. 대화 프로세스는 끝낸다 |

### 설계
| 파일 | 내용 |
|---|---|
| `src/shared/chat.ts` (순수) | `ChatEvent` 공통 모양(user · text · tool_start · tool_end · permission · question · answered · turn_end · error · usage · session · stopped) · `claudeLineToEvents(obj, ctx)` 변환 · `parseClaudeLine` · `chatPermissionArgs` · `foldBlocks(events)`(화면 블록: 턴별 도구 묶음 · 대기 카드) · `chatStatus(events)` · `isDangerousTool(tool, input, cwd)` · `redactEvent(ev, opts)` |
| `src/main/chat/claude-adapter.ts` | 프로세스 하나 감싸기: 띄우기 · 줄 나누기 · `send(text)` · `answer(requestId, decision)` · `interrupt()` · `kill()`. `spawn` 을 주입해 단위 시험 |
| `src/main/chat/chat-manager.ts` | paneId → 어댑터. 보내기 때 없으면 띄운다(lazy, sessionId 있으면 `--resume`). 이벤트를 가려서(redact) 창으로 · 저장소로. 창 닫힘 · 앱 끝 · pane 지움에 kill |
| `src/main/chat/chat-store.ts` | `<userData>/chat/<paneId>.jsonl` (0600, 폴더 0700) — 가린 이벤트만 한 줄씩. 읽기(재시작 뒤 화면) · 지우기(pane 지움 · 알림 끝 onEnd) · 크기 상한(2MB 넘으면 앞을 잘라 냄) |
| `src/main/chat/find-bin.ts` | `TASKMINAL_CLAUDE_BIN`(e2e 가짜) → 아니면 로그인 셸(`$SHELL -lc 'command -v claude'`, 5초)로 경로 · PATH. Finder 실행에서도 찾게. 없으면 'missing' 오류 이벤트 |
| IPC (`src/shared/ipc.ts`) | `chat:send` · `chat:answer` · `chat:interrupt` · `chat:history`(invoke) · `chat:event`(main→창) · `chat:close`. main 은 paneId(`isPaneId`) · 글 길이(100k) · 답 모양을 검사 |
| `src/renderer/ChatPane.tsx` · `chat-ui.tsx` | 위 화면. `SplitView` 가 `pane.kind === 'chat'` 이면 TerminalPane 대신 |
| `src/main/menu.ts` · keymap | ⇧⌘J '터미널로 전환'(대화 pane 일 때) · ⌘. '멈춤'(대화 입력창 안에서만, 메뉴 없음 — 터미널 ⌘. 과 겹치지 않게 대화 pane 포커스일 때만) |

### 가린 사본이 닿는 곳 (rc2deda)
| 곳 | 무엇을 | 어떻게 |
|---|---|---|
| 화면(창으로 가는 이벤트) | 글 · 도구 입력 요약 · 도구 결과 꼬리 · 허락 명령 · 질문 | main 에서 `redact` 뒤에 보냄. 단 **허락 카드에 보일 명령은 가린 글**, claude 로 돌려줄 `updatedInput` 은 main 이 들고 있는 원래 입력(가린 글을 돌려주면 명령이 바뀐다) |
| 디스크(`chat/*.jsonl`) | 위와 같은 가린 이벤트 | 저장 전 redact · 0600 |
| 내가 쓴 글 | 사용자 글 | claude 로는 원문(사용자가 보낸 것), 화면 · 디스크에는 가린 글 |
| 다시 시도 | 마지막 보낸 글 | main 이 원문을 메모리에만 들고 있다가 다시 보냄(디스크의 가린 글을 보내지 않는다). 재시작 뒤에는 원문이 없으니 [다시 시도] 대신 입력창에 가린 글을 넣지 않고 숨김 |
| 기록(19) · 찾기(⇧⌘F) | 대화는 셸 명령이 아니라 기록에 넣지 않음 · ⇧⌘F 는 터미널 버퍼만 — 대화는 이번 범위 밖(하지 않는 것) |

### 칸 (plan-check · 계획 규칙)
- ① 결과를 모를 때: 보낸 뒤 프로세스가 `result` 없이 끝나면(크래시 · kill) '실패 · (종료 코드 n)' 띠 + [다시 시도] — 보낸 글이 claude 세션에 들어갔는지 모르므로 다시 시도는 같은 글을 새 턴으로 보내고 안내 문구에 "이미 들어갔으면 두 번 보일 수 있어요".
- ② 다시 시도: 어디서 — 같은 대화(sessionId 있으면 `--resume`)에 마지막 원문을 새 턴으로. 로그인 · 설치 띠의 [다시 시도]는 프로세스를 새로 띄운 뒤 보냄.
- ③ 이중 입력: 실행 중에는 ↩ 가 보내지 않는다(입력창 글은 남고 안내 '끝나면 보낼 수 있어요 · ⌘. 멈춤'). 허락 · 질문 카드는 답을 한 번 보내면 카드가 '허락함/거절함/답함' 으로 굳고, 같은 requestId 의 두 번째 답은 main 이 버린다(어댑터의 대기 목록에서 지운 뒤 보냄).
- ④ 취소 · 닫기: ⌘. → interrupt → '■ 멈춤(내가 멈춤)'(실패 아님). 실행 중 pane 을 닫으면 kill · 그 대화 파일은 pane 지움과 같이 되돌리기 알림 끝(onEnd)에 지움. 앱 종료 4경로: 앱 종료 · 창 닫기 → 모든 claude kill(지킴이처럼 살리지 않는다 — 다음 보내기에서 `--resume`), 새로 고침 → main 의 어댑터는 살아 있고 창은 `chat:history` 로 다시 그림, 렌더러 충돌 → 같음.
- 열린 카드의 대상이 사라짐(r4ee705): 허락 카드가 열린 채 프로세스가 끝나면(멈춤 · 크래시) 카드는 '응답 없이 끝남' 으로 굳고 단추가 사라진다. 답을 누른 순간 main 이 requestId 를 대기 목록에서 다시 찾고 없으면 버린다(e2e 하나).
- ⑦ 늦게 도착하는 옛 응답: 프로세스 세대 번호 — 다시 띄운 뒤 옛 프로세스의 늦은 줄 · exit 는 세대가 달라 버린다.
- ⑧ 부수 요청: 대화 하나에 프로세스 하나 · 보내기는 실행 중이면 막음(한 번에 하나). 안 보이는 대화 pane 은 아무 것도 주기적으로 돌리지 않는다(주기 없음). 건너뛴 요청: 실행 중에 막힌 보내기는 버리지 않고 입력창에 글이 남아 끝난 뒤 사용자가 ↩ 로 다시 보낸다(자동 대기열은 22) · 허락 방식 바꾸기가 프로세스를 띄우는 중에 오면 띄운 뒤에 한 번 더 맞춘다(앞 요청 뒤 다시 돈다).
- ⑨ 처음 한 번만 읽는 값: 허락 방식은 프로세스를 띄울 때 인자로만 들어간다 → 바꾸면 다음 턴부터 맞게, 지금 떠 있는 프로세스에는 `control_request set_permission_mode` 를 보낸다(스파이크 미확인 → 안 되면 다음 띄울 때부터, 칩에 '다음 보내기부터'). CLI 경로는 앱이 뜬 뒤 처음 찾을 때 한 번 — 'CLI 없음' 띠의 [다시 찾기] 가 다시 찾는다.

## 2. 범위 — 21b 사이드바 흐름 보기 (design-gaps 4 · Sidebar 보드)

| 보드 | 할 일 |
|---|---|
| 기본 '흐름' 보기 · '묶음' 전환 | 머리에 [흐름 | 묶음] 전환(설정 `sidebarView`, 기본 'flow'). 흐름 = 확인 필요(노란 상자 · ⇧⌘A) → 설정의 상태 순서대로 칸 → 마지막 상태(완료)는 접힘. 묶음 = 지금 보기 |
| 칸마다 개수 · 접기 | 칸 제목 + 개수 · ▸/▾ 접기(설정에 저장) |
| 전체 줄 개수 막대 | 사이드바 맨 위 '확인 n · 실행 n · 끝남 n · 조용 n' 막대(0 인 칸은 숨김) |
| 거르기 칸 `/` | 이름 · 폴더 · 브랜치 · 묶음 이름으로 거름. `/` 로 포커스(터미널 · 입력칸 포커스일 때는 아님 — 사이드바에 포커스가 있을 때와 메뉴 '일감 거르기'), Esc 로 비우고 나감 · 맞는 게 없으면 '맞는 일감 없음' |
| 상태 옮기기 | 줄을 다른 칸으로 끌어 놓기 · 우클릭 '상태' 메뉴(있음) · 빈 칸 '여기로 끌어 놓기' |
| 본 것 · 안 본 것 | 안 본 출력 점 + 굵은 이름: 활동이 '끝남' · '실패' 이고 그 일감을 아직 고르지 않았으면. 고르면 사라짐 |
| 줄 3단 | 이름 + 안 본 점 + 몇 분 전 / 폴더 · 상태(또는 흐름 보기에서는 묶음) · 터미널 수 + 활동 아이콘. **마지막 한 줄(출력)은 하지 않음** — 아래 '하지 않는 것' |

UX 점수표(보드 10기준): 만든 뒤 e2e 스크린샷으로 다시 매기고 결과 절에 적는다. 80 아래면 그 기준을 고친다.
⌥⌘↑/↓ 는 이미 '다음 · 이전 일감'(8단계)이라 상태 옮기기 키로 쓰지 않는다 — 계획과 다르게 한 것.

## 3. 시험
단위
- `tests/unit/chat.test.ts`: fixture 줄들 → 이벤트(글 · 도구 시작/끝 · 허락 · 질문 · 턴 끝 · 로그인 오류 · 멈춤 · 한도 · 사용량 %) · `foldBlocks` 묶음 · `chatStatus` · 위험 도구 판정 · redact 가 글 · 명령 · 결과에 적용되고 원래 입력은 따로 남는지 · 허락 방식 → 인자.
- `tests/unit/chat-adapter.test.ts`: 가짜 spawn — 줄이 쪼개져 와도 한 줄로 · 답을 두 번 보내면 한 번만 · 세대가 지난 exit 는 버림 · interrupt 줄 모양 · `--resume` 인자.
- `tests/unit/chat-store.test.ts`: 0600 · 가린 글만 · 상한 넘으면 앞 잘림 · 지우기.
- `tests/unit/sidebar-model.test.ts` 더함: 흐름 칸 나누기(확인 필요는 위로 · 상태 순서 · 모르는 상태는 첫 칸) · 거르기 · 개수 막대 · 안 본 것.
e2e (`tests/fixtures/fake-claude.mjs` — fixture 대본을 따라 줄을 내보내는 가짜 claude, `TASKMINAL_CLAUDE_BIN`)
- `tests/e2e/chat.spec.ts`
  1. ⌘P '새 대화' → 처음 화면 → 글 보내기 → 글 · 도구 묶음 줄 · 끝남 상태 · 스크린샷
  2. 허락 카드 ↩ → 가짜가 allow 를 받고 결과 출력 / Esc → deny 가 감 · 카드 '거절함'
  3. 질문 카드 2 → ↩ → answers 에 두 번째 label
  4. 재시작 뒤 같은 세션: 앱을 끄고 켜면 앞 대화가 보이고, 다음 보내기의 인자에 `--resume <id>`(가짜가 받은 인자를 파일로 남김)
  5. 허락 방식 '자동' 으로 바꾸고 재시작 → 칩 그대로 · 인자 `--permission-mode auto`
  6. 로그인 없음 대본 → 로그인 띠 · 실패(크래시) 대본 → 실패 띠 + 다시 시도 → 같은 글이 다시 감
  7. ⌘. 멈춤 → '■ 멈춤' (실패 아님)
  8. ⇧⌘J → 같은 자리에 터미널 pane, 시작 명령 `claude --resume <id>`(가짜 PATH 의 claude 가 인자를 찍음)
  9. 허락 카드가 열린 채 프로세스가 끝나면 카드가 '응답 없이 끝남' 으로 굳음
  10. 비밀값: 가짜가 `sk-ant-…` 를 글로 내보내면 화면 · `chat/*.jsonl` 에 원문 없음
- `tests/e2e/sidebar.spec.ts` 더함: 흐름 보기 칸 순서 · 끌어 놓기로 상태 바뀜 · `/` 거르기 · 묶음 전환 · 안 본 점 · 스크린샷

## 4. 순서 → verify
1. fixture 정리 · `chat.ts` 시험 → 구현 → vitest
2. adapter · store · find-bin · manager · IPC · preload → 단위 · typecheck · 경계
3. ChatPane · SplitView · App(새 대화 · 전환 · 설정) → 가짜 claude · chat.spec → 21a 커밋
4. 사이드바 흐름 보기 → sidebar 단위 · e2e · 스크린샷으로 UX 표 → 21b 커밋
5. 변이 확인(핵심 줄: 허락 답 한 번만 · 세대 · redact 적용 · resume 인자 · 허락 방식 저장 · 흐름 칸 · 거르기) → 전체 검사 → `/code-review medium` → 고친 것 별도 커밋 → 문서 · 병합 · 회고

## 5. 하지 않는 것
- Codex · 이미지 · 되감기 · 나누기 · 대기열 · 지금 보내기(22) · diff 카드 · 변경 검토(23) · 여러 에이전트 지휘(24) · AI 사용량 막대(사이드바 아래 — 5번 항목 별도)
- 대화 안 찾기 ⌘F · 레일(메시지 목록) · 가상 스크롤 · @ 파일 · / 명령 · ↑ 보낸 글 다시 부르기
- 터미널 → 대화 전환(반대 방향) — 터미널 claude 의 세션 id 를 알 길이 없다(24 의 OSC 로)
- 사이드바 줄의 '마지막 한 줄(출력)' · 몇 분 전 — pane 출력 마지막 줄을 모으는 길이 아직 없다. 3단 대신 2단 + 안 본 점
- 대화 프로세스를 셸 지킴이처럼 앱 밖에 살려 두기 — 앱이 끝나면 끝나고 `--resume` 으로 잇는다
