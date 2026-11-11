# 22단계 — 대화 2 (Codex · 확장)

`docs/plan.md` 22 줄: Codex 어댑터(app-server JSON-RPC · 승인) · 이미지 붙이기 · 되감기 · 여기서 새 대화로 나누기 · 대기열 · 지금 보내기 (Chat).
verify: e2e(가짜 codex) — 같은 카드로 승인 · 이미지 첨부가 메시지에 실림 · 되감기 뒤 이후 메시지 사라짐.
21단계에서 넘어온 것: 여러 개 고르기(multiSelect) 질문.
보드: Chat(대화). 브랜치 `stage-22-chat-codex`. 커밋은 22a Codex 어댑터 → 22b 이미지 · 되감기 · 나누기 · 대기열 · 여러 개 고르기 로 나눈다.

plan-check: 서버 없음 — 앱은 로컬 codex · claude 프로세스(stdin/stdout)와 로컬 파일에만 쓴다. API 호출은 각 CLI 몫

## 0. 스파이크 결과 (2026-11-11)

**codex 는 이 Mac 에 없고 로그인도 없다.** `npm install --prefix <scratchpad>` 로 codex-cli 0.167.1 을 임시로 받아, `CODEX_HOME=<임시 폴더>`(사용자 `~/.codex` 는 없음 · 만들지 않음)로 돌렸다.
- 프로토콜: `codex app-server generate-ts` 로 만든 타입(665개)을 읽었다. 실제 프로세스에 보낸 요청 · 받은 줄은 `tests/fixtures/codex/*.jsonl`(경로 · id 를 짧게 바꾼 사본).
- 로그인이 필요한 것(모델이 실제로 답하는 글 · 명령 실행 · 승인 요청 · 질문)은 **타입으로만 확인 · 실제 줄은 미확인**. 가짜 codex 는 타입 모양 그대로 흉내 낸다.

| 무엇 | 실제 모양 (codex app-server, stdio · 줄마다 JSON-RPC, `"jsonrpc"` 칸 없음) |
|---|---|
| 띄우기 | `codex app-server` — 한 프로세스가 스레드 여럿을 맡고 턴 사이에도 산다 |
| 시작 | 요청 `initialize {clientInfo:{name,title,version},capabilities:null}` → 답 `{userAgent,codexHome,…}` · 알림 `initialized {}` |
| 로그인 확인 | `account/read {refreshToken:false}` → 로그인 없으면 `{account:null, requiresOpenaiAuth:true}` (확인) |
| 스레드 | `thread/start {cwd, approvalPolicy, sandbox}` → `{thread:{id,…,model}}` · `thread/resume {threadId, excludeTurns:true}`(새 프로세스에서 확인) · `thread/fork {threadId, lastTurnId}` → 새 `thread.id` + `forkedFromId`(확인) |
| 보내기 | `turn/start {threadId, input:[{type:'text',text,text_elements:[]},{type:'localImage',path}]}` → `{turn:{id,status:'inProgress'}}` — **이미지 경로가 userMessage 항목에 그대로 실림(확인)** |
| 진행 | 알림 `turn/started` · `item/started` · `item/completed`(항목: `agentMessage{text}` · `commandExecution{command,status,exitCode,aggregatedOutput}` · `fileChange{changes[{path,kind,diff}]}` · `userMessage` · `reasoning` …) · `thread/tokenUsage/updated{tokenUsage{last,modelContextWindow}}` |
| 끝 | `turn/completed {turn:{status:'completed'|'failed'|'interrupted', error?{message,codexErrorInfo}}}` (failed · interrupted 확인) |
| 멈춤 | `turn/interrupt {threadId, turnId}` → `{}` + `turn/completed status:'interrupted'`(확인) |
| 승인 (서버 → 앱 요청) | `item/commandExecution/requestApproval {threadId,turnId,itemId,command?,cwd?,reason?}` → 답 `{decision:'accept'|'acceptForSession'|'decline'|'cancel'}` · `item/fileChange/requestApproval {…,reason?,grantRoot?}` → 같은 답 (타입만) |
| 질문 (서버 → 앱 요청) | `item/tool/requestUserInput {questions[{id,header,question,options[{label,description}]|null}]}` → `{answers:{[id]:{answers:[label…]}}}` (타입만) |
| 로그인 없음 | `turn/start` 는 받아들이고 401 로 다시 시도(`error {willRetry:true}`) → 마지막에 `turn/completed status:'failed', error.codexErrorInfo.httpConnectionFailed.httpStatusCode:401` — 15초쯤 걸린다 → **보내기 전에 `account/read` 로 막는다** |
| 되감기 | `thread/revert {threadId, beforeTurnId}` 는 **대화 기록만** 바꾸고 파일은 되돌리지 않는다(타입 주석 · 확인) |

Claude (claude 2.1.322, haiku, 임시 폴더 · `--setting-sources project`, `tests/fixtures/claude/fork.jsonl`):
| 무엇 | 실제 모양 |
|---|---|
| 이미지 | stdin user 메시지 content 에 `{type:'image',source:{type:'base64',media_type:'image/png',data}}` → 1×1 빨강 PNG 를 "Red" 로 답함(확인) |
| 나누기 · 되감기 | `--resume <id> --fork-session --resume-session-at <assistant uuid>` → **새 session_id** 에 그 assistant 줄까지만 남는다(ALPHA 만 기억 · BETA 는 없음, 확인). `--resume-session-at` 은 `--help` 에 없는 옵션 — CLI 가 바뀌면 깨질 수 있다(결과 절에 적음) |
| 줄 id | `assistant` 줄마다 `uuid` 가 있다 |

전제 변경
- 보드 '되감기 — 파일 12개와 이후 메시지가 되돌아가요' → **파일은 되돌리지 않는다.** Codex `thread/revert` 는 기록만, Claude 는 파일 체크포인트를 stream-json 으로 부를 길이 없다(스파이크에 없음). 확인 띠에 "파일은 그대로예요 · 바뀐 파일은 git 으로" 를 적는다 — 계획과 다르게 한 것.
- 되감기 · 나누기를 두 에이전트 모두 **'그 지점에서 갈라 새 세션'** 으로 만든다(Claude `--fork-session --resume-session-at` · Codex `thread/fork lastTurnId`). 옛 세션은 그대로 남는다. Codex `thread/revert` 는 쓰지 않는다(Claude 와 같은 길 · 옛 세션을 지우지 않음).

## 1. 범위

### 이렇게 만든다 (보드 → 할 일)
| 보드 | 할 일 |
|---|---|
| Codex 어댑터 · 같은 이벤트 모양 | `src/main/chat/codex-adapter.ts` — app-server 하나를 대화 pane 하나가 쓴다. 21단계 `ChatEvent` 로 바꿔 같은 화면 |
| Codex 배지(초록) · 모델 표시 | 머리 배지 'Codex'(보드 색) · 입력줄 모델 표시(세션 이벤트의 model, 읽기만) |
| ⌘P '새 대화 (Codex)' · '대화(Codex)로 오른쪽 나누기' | keymap 명령 `chat-new-codex` · `chat-split-codex`. 탭 이름 'Codex 대화' |
| 같은 허락 카드 ↩ / ⌥↩ / Esc | 명령 승인 · 파일 승인 → `permission` 이벤트(도구 'Bash' · 'Edit'). ↩ accept · ⌥↩ 앱이 기억해 같은 명령은 accept 로 바로 답(이 대화 동안 · 위험이면 이번 한 번만) · Esc decline(거절 이유는 다음 턴 글로 — codex 승인 답에는 글 칸이 없다) |
| 질문 카드 | `requestUserInput` → `question` 이벤트, 답은 질문 id 로 되돌린다 |
| CLI 없음 · 로그인 · 한도 띠 | 'codex 명령을 찾지 못했어요'(설치 명령 `npm install -g @openai/codex` 복사) · 'Codex 에 로그인되어 있지 않아요'([터미널 열기] = 새 탭에서 `codex login`) · 한도(`codexErrorInfo` 의 usageLimitExceeded — 미확인, 문자열로 판정) |
| ⇧⌘J 터미널 전환 | Codex 는 `codex resume <thread id>`(없으면 `codex`) — `TASKMINAL_CODEX_TUI` |
| 📎 이미지 · 붙여넣기 · 끌어 놓기 | 입력창에 ⌘V(클립보드 이미지) · 파일 끌어 놓기 · 📎 단추(main 파일 고르기). 보내기 전 칩(이름 · ×). 한 번에 4장 · 장마다 5MB(PNG · JPEG · GIF · WebP). 보낸 메시지에 '🖼 이름' |
| ↶ 여기로 되감기 | 내가 쓴 메시지에 마우스를 올리면 [↶ 여기로 되감기] [⑂ 여기서 새 대화로 나누기]. 되감기 → 확인 띠 '여기로 되돌릴까요? 이후 메시지 n개가 사라져요 · 파일은 그대로예요 · 되감은 내 메시지는 입력창에 다시 넣어 드려요' [되돌리기 ↩] [닫기 Esc] |
| ⑂ 여기서 새 대화로 나누기 | 오른쪽에 새 대화 pane(같은 에이전트) — 그 메시지의 답까지 남은 기록 + 다음 보내기가 그 지점에서 갈라진 세션 |
| 대기열 · 지금 보내기 | 도는 동안 ↩ 는 대기열에 넣는다. 입력창 위 '대기 n' 줄(첫 글 · [고치기] · [×] · [지금 보내기 ⌘↩]). 턴이 잘 끝나면 다음 것을 저절로 보낸다. 실패 · 한도 · 멈춤이면 '대기 n · 멈춤' + [이어 보내기]. ⌘↩ = 지금 것을 멈추고 대기열 첫 것을 보냄 |
| 여러 개 고르기 (21 넘김) | `multi` 질문은 1~9 가 켜고 끄기(체크) · 답은 고른 label 들. Claude 는 `", "` 로 이은 글, Codex 는 배열 |

### 설계
| 파일 | 내용 |
|---|---|
| `src/shared/chat.ts` | `ChatAgent = 'claude' | 'codex'` · `user` 이벤트에 `images?: string[]`(이름) · `turn_end` 에 `anchor?: string`(Claude 마지막 assistant uuid · Codex turn id) · `ChatDecision` 의 `answers: Record<string, string | string[]>` · `codexNoteToEvents` · `codexRequestToEvents`(알림 · 요청 → 이벤트, 순수) · `codexPolicy(permission)` · `rewindPlan(events, index, mode)`(되감기 · 나누기가 남길 이벤트 수 · 갈라질 anchor · 입력창에 다시 넣을 글 — 가린 글이면 넣지 않음) |
| `src/main/chat/claude-adapter.ts` | 보내기에 이미지(base64 블록) · `forkAt`(다음 띄울 때 `--resume <id> --fork-session --resume-session-at <uuid>`) · 질문 답 배열 → `", "` · 턴 끝에 마지막 assistant uuid |
| `src/main/chat/codex-adapter.ts` | `CodexSession` — 띄우기 · JSON-RPC 줄 · 요청 번호 · `initialize` → `account/read` → `thread/start|resume|fork` → `turn/start`. 서버 요청(승인 · 질문)은 대기 목록 → 답. 모르는 서버 요청은 JSON-RPC 오류로 바로 답(멈추지 않게). `ClaudeSession` 과 같은 겉모양(`AgentSession`) |
| `src/main/chat/chat-manager.ts` | pane 마다 에이전트에 맞는 세션. `send(…, chat:{agent,sessionId,forkAt}, images)` · `rewind(paneId, index, at)` · `branch(from, to, index, at)` — 기록 파일을 잘라 쓰거나 복사 |
| `src/main/chat/chat-store.ts` | `replace(paneId, events)`(임시 파일 → rename) · `copy(from, to, n)` · 이미지 파일 `<userData>/chat/<paneId>.img/<n>.<ext>`(0600 · codex 경로용) · `remove` 가 이미지 폴더도 |
| `src/main/chat/find-bin.ts` | `codex()` — `TASKMINAL_CODEX_BIN` · 로그인 셸 `command -v codex` |
| IPC | `chat:send` 에 agent · forkAt · 이미지 · `chat:rewind`(invoke → 새 기록) · `chat:branch`(invoke) · `chat:pick-images`(invoke, main 파일 고르기) |
| `src/shared/types.ts` · `model.ts` | `Pane.chat = { agent, sessionId?, forkAt? }`. `addChatTab(task, newId, agent)` · `chatRewound(task, paneId, forkAt|null)` · `branchChat(task, paneId, newId, forkAt)` · `chatToTerminal` 의 명령이 에이전트별 · `setChatSession` 이 forkAt 을 지움 |
| `src/renderer/ChatPane.tsx` | 배지 · 이미지 칩 · 되감기/나누기 단추 · 확인 띠 · 대기열 줄 · 여러 개 고르기 |

### 가린 사본이 닿는 곳 (rc2deda)
| 곳 | 무엇을 | 어떻게 |
|---|---|---|
| 화면 · 디스크(Codex 이벤트) | 글 · 명령 · 결과 꼬리 · 승인 이유 · 질문 | 21단계와 같다: main 이 `redact` 뒤에 창으로, ChatStore 가 쓰기 전에 가림. 승인 답은 codex 가 보낸 요청 id 로만(명령 글을 돌려주지 않음) |
| 이미지 | 그림 자체는 가릴 수 없다 | 이름만 가려서 화면 · 디스크에. Claude 로는 base64 를 메모리에서 바로 보내고 디스크에 남기지 않는다. Codex 는 경로가 필요해 `<pane>.img/` 에 0600 으로 쓰고 pane 기록을 지울 때 함께 지움 |
| 되감기 → 입력창에 다시 넣기 | 되감은 내 메시지 | 디스크 · 화면에는 가린 글뿐 → 가린 표시(‹가림›)가 있으면 **넣지 않고** 안내 '가린 글이 있어 다시 넣지 않았어요'(19단계 `hasMask`) |
| 나누기 · 되감기 기록 | 남길 이벤트 | 이미 가린 디스크 기록을 잘라 쓰거나 복사(새로 가릴 원문이 없다) |
| 대기열 | 기다리는 글(원문) | renderer 메모리에만 — 디스크 · 상태 파일에 쓰지 않는다. 창을 새로 고치거나 앱을 끄면 사라진다(하지 않는 것) |
| 다시 시도 | 21단계와 같다(원문은 메모리, 재시작 뒤 숨김) | — |

### 칸 (plan-check · 계획 규칙)
- ① 결과를 모를 때: Codex 프로세스가 `turn/completed` 없이 끝나면 '실패 · (종료 코드 n)' 띠(21과 같은 크래시 처리). 승인 답을 보낸 뒤 프로세스가 끝나면 카드는 이미 굳었고 띠가 원인을 보인다. 되감기 · 나누기 invoke 가 실패하면(파일 쓰기 실패) 화면은 그대로 두고 알림 '되감지 못했어요'.
- ② 다시 시도: 21과 같다 — 같은 대화(스레드 id 있으면 `thread/resume`)에 마지막 원문을 새 턴으로. 로그인 띠의 [다시 시도] 는 `account/read` 부터 다시.
- ③ 이중 입력: 도는 동안 ↩ 는 보내지 않고 대기열에 넣는다(보내는 것은 한 번에 하나 — 턴이 끝나야 다음 것). 대기열 자동 보내기는 턴 끝 이벤트 하나에 한 번만(같은 끝을 두 번 보지 않게 처리한 끝 번호를 둔다). 되감기 확인 [되돌리기 ↩] 를 두 번 눌러도 main 이 이벤트 자리를 다시 확인하므로 두 번째는 자리가 맞지 않아 버린다. 승인 답 두 번은 21처럼 대기 목록에서 지운 뒤 보내 두 번째는 버린다.
- ④ 취소 · 닫기: 되감기 확인 띠는 Esc · [닫기] 로 아무것도 안 함. ⌘. 멈춤은 `turn/interrupt` → '■ 멈춤' + 대기열 멈춤. 실행 중 pane 을 닫으면 codex 프로세스 kill(21과 같다). 앱 종료 4경로: 앱 종료 · 창 닫기 → 모든 codex kill(다음 보내기에서 `thread/resume`), 새로 고침 → main 세션은 살아 있고 창은 history 로 다시 그림 · 대기열은 사라짐, 렌더러 충돌 → 같음.
- ⑩ 턴 도중 앱이 끝남: 21단계 `history` 가 프로세스 없는 열린 턴을 멈춤으로 닫는 것이 Codex 에도 그대로 — 열린 턴은 다시 그릴 때 멈춤으로 닫힌다(e2e 는 21의 것을 에이전트만 바꿔 하나).
- 열린 확인 · then 의 대상이 사라짐(r4ee705): 되감기 확인 띠가 열린 사이 이벤트가 더해지면(그 사이 턴이 시작될 수 없다 — 도는 중에는 단추가 없음 — 그래도) main 이 `index` 자리의 이벤트가 같은 `user` 이벤트(시각 `at` 까지 같음)인지 다시 보고 다르면 버린다 → 알림. 나누기도 같다. 대기열 [고치기] 로 입력창에 꺼낸 사이 턴이 끝나도 그 글은 대기열에서 이미 빠졌다.
- ⑦ 늦게 도착하는 옛 응답: Codex 요청마다 번호 · 프로세스 세대. 되감기 뒤 옛 스레드의 늦은 알림(threadId 가 다름)은 버린다. 다시 띄운 뒤 옛 프로세스의 exit 는 세대로 버린다(21과 같다).
- ⑧ 부수 요청: 주기로 도는 것은 없다. 보내기는 한 번에 하나 — 대기열이 차례를 지킨다. 건너뛴 보내기(턴이 열려 있어 'busy')는 버리지 않고 대기열 맨 앞으로 되돌려, 턴이 끝난 뒤 다시 보낸다. 안 보이는 pane 의 대기열도 턴 끝 이벤트로 돈다(창은 이벤트를 받는다 — 일부러 보이는 것만으로 줄이지 않는다: 사용자가 맡긴 순서).
- ⑨ 처음 한 번만 읽는 값: 허락 방식은 Codex 에 턴마다 `approvalPolicy` 로 보낸다(처음 한 번이 아니다) → 바꾸면 다음 턴부터. codex 경로는 처음 찾을 때 한 번 — 'CLI 없음' 띠의 [다시 시도] 가 다시 찾는다. 로그인 여부는 프로세스를 띄울 때마다 `account/read` 로 다시 본다(로그인한 뒤 다시 시도하면 바로 된다).

## 2. 허락 방식 → Codex
| 앱 설정 | approvalPolicy | sandbox |
|---|---|---|
| ask(매번 묻기) | `untrusted` | `workspace-write` |
| edits(파일 고치기는 자동) | `on-request` | `workspace-write` |
| auto(자동) | `never` | `workspace-write` |
사용자 `~/.codex/config.toml` 은 건드리지 않는다(요청 인자로만).

## 3. 시험
단위
- `tests/unit/chat-codex.test.ts`: fixture 줄 → 이벤트(세션 · 글 · 명령 시작/끝 · 파일 바꿈 · 승인 · 질문 · 턴 끝 completed/failed/interrupted · 401 → 로그인 · 토큰 %) · `codexPolicy`.
- `tests/unit/codex-adapter.test.ts`(가짜 spawn): 시작 순서 initialize → account/read → thread/start → turn/start · 로그인 없음이면 turn 을 보내지 않고 login 오류 · sessionId 면 thread/resume · forkAt 이면 thread/fork lastTurnId · 승인 답 두 번 → 한 번 · 늘 허락이 다음 같은 명령에 바로 accept · 위험이면 늘 허락 안 됨 · 질문 답이 질문 id 로 · 모르는 서버 요청에 오류 답 · interrupt 줄 · 이미지 → localImage · 옛 세대 exit 버림 · 다른 스레드 알림 버림.
- `tests/unit/chat-adapter.test.ts` 더함: 이미지 블록 · forkAt 인자 · 여러 개 고르기 답 `", "` · 턴 끝 anchor.
- `tests/unit/chat.test.ts` 더함: `rewindPlan`(첫 메시지 → anchor 없음 · 가린 글은 다시 넣지 않음 · 나누기는 그 턴 끝까지) · foldBlocks 의 user 이미지.
- `tests/unit/chat-store.test.ts` 더함: replace · copy · 이미지 파일 0600 · remove 가 이미지도.
- `tests/unit/chat-manager.test.ts` 더함: rewind 가 자리가 다르면 버림 · branch 복사.
- `tests/unit/model.test.ts` 더함: codex pane 읽기 · forkAt · 터미널 전환 명령.
e2e (`tests/fixtures/fake-codex.mjs` — JSON-RPC 대본, `TASKMINAL_CODEX_BIN` · `FAKE_CODEX_LOG`)
- `tests/e2e/chat-codex.spec.ts`
  1. ⌘P '새 대화 (Codex)' → 보내기 → 글 · 명령 줄 · 끝남 · 배지 'Codex' · 스크린샷
  2. 같은 카드로 승인: ↩ → 가짜가 accept 를 받고 명령 결과 / Esc → decline · 카드 '거절함'
  3. 로그인 없음 → 로그인 띠(보내기 전에 막혀 turn/start 가 가지 않음)
  4. 재시작 뒤 `thread/resume` 에 저장된 스레드 id · 앞 대화가 보임
  5. 이미지: 📎(가짜 파일 고르기) → 칩 → 보내기 → 가짜가 받은 `localImage` 경로의 파일이 있다 · 메시지에 '🖼'
  6. 되감기: 두 턴 → 두 번째 메시지 되감기 → 확인 → 이후 메시지 사라짐 · 입력창에 그 글 · 다음 보내기가 `thread/fork lastTurnId=<첫 턴>`
- `tests/e2e/chat.spec.ts` 더함(가짜 claude)
  7. 이미지 붙여넣기(⌘V 이미지) → 가짜 claude stdin 에 image 블록
  8. 되감기 → `--fork-session --resume-session-at <uuid>` · 화면에서 이후 메시지 사라짐 · 재시작 뒤에도 사라진 채
  9. 나누기 → 오른쪽 새 대화 pane 에 그 턴까지 · 보내면 fork 인자
  10. 대기열: 느린 턴 중 ↩ 두 번 → '대기 2' → 끝나면 차례로 보냄 · ⌘↩ 지금 보내기 → 멈춤 뒤 첫 것
  11. 여러 개 고르기: 1 · 3 → 답 'A, C'
  12. 가린 글: 비밀값을 보낸 메시지를 되감으면 입력창에 넣지 않고 안내

## 4. 순서 → verify
1. fixture · `chat.ts` Codex 변환 시험 → 구현 → vitest
2. codex-adapter · find-bin · manager · IPC · preload · model → 단위 · typecheck · 경계
3. ChatPane(배지 · Codex 띠) · App(새 대화 Codex · 전환 · 로그인) → 가짜 codex · chat-codex.spec 1~4 → 22a 커밋
4. 이미지 · 되감기 · 나누기 · 대기열 · 여러 개 고르기 → 단위 · e2e 5~12 → 22b 커밋
5. 변이 확인(핵심 줄: 로그인 막기 · 승인 답 한 번 · 늘 허락 위험 · 질문 id · fork 인자 · rewind 자리 확인 · 가린 글 안 넣기 · 대기열 자동 보내기 한 번 · 이미지 0600 · multi join) → 전체 검사 → `/code-review medium` → 고친 것 별도 커밋 → 문서 · 병합 · 회고

## 5. 하지 않는 것
- 파일 되돌리기(체크포인트) — 위 전제 변경. '바뀐 파일 보기' 단추 · diff 카드 · 변경 검토(23)
- 여러 에이전트 지휘 · CLI 소켓(24)
- @ 파일 · / 명령 · ↑ 보낸 글 다시 부르기 · ⌘F 대화 찾기 · 레일 · 가상 스크롤 · 모델 고르기(표시만)
- 대기열을 디스크에 남기기 — 원문이라 남기지 않는다(새로 고침 · 재시작에 사라짐)
- Codex 의 '생각(reasoning)' · 계획(plan) 항목 보이기 · `turn/steer`(돌고 있는 턴에 끼워 넣기) — '지금 보내기' 는 멈춤 뒤 보내기로 두 에이전트를 같게
- 터미널 codex 의 세션을 대화로 가져오기(반대 방향)
- 사용자 `~/.codex` · `~/.claude` 설정 바꾸기
