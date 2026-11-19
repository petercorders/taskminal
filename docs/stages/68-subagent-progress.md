# 68 — 대화 pane 에서 Claude 하위 에이전트 진행을 따로 보기

사용자 2026-11-19 "진행해줘" — `docs/ideas/next-five-v6.md` 2번. 자율 진행 지시대로 선택은 추천안으로 정했다.
**사용자 지시: e2e 는 돌리지도 새로 쓰지도 않고 앱도 띄우지 않는다** — 검증은 typecheck · 경계 · 간격 · 단위 · 변이까지다.

## 문제
대화 pane 은 stream-json 줄의 `parent_tool_use_id` 를 보지 않았다(`claudeLineToEvents`). 하위 에이전트(Agent 도구)가 부른 도구 · 중간 글이 본 에이전트의 도구 줄 · 글로 섞여 보였고, 하위 작업 진행 사건(`system task_*`)은 버렸다.
또 턴 끝 anchor(되감기 · 나누기가 가르는 자리)가 하위 에이전트 줄의 uuid 도 받았다 — 하위 줄이 본 에이전트 마지막 줄 뒤에 오면 `--resume-session-at` 이 본 세션에 없는 자리를 받는다.

## 실측 (claude 2.1.325, 실제 계정 2회 · 2026-11-19)
- 시험 재료 `tests/fixtures/claude/subagent.jsonl`(하위 에이전트가 도구 없이 답함) · `subagent-tools.jsonl`(Read 두 번) — 실측 출력을 줄이고 세션 id · uuid · 출력 파일 · 절대 경로 · 요청 id · 생각 서명을 바꾸거나 뺐다.
- 하위 에이전트의 assistant · user 줄은 `parent_tool_use_id` = 그 Agent tool_use id. 지시는 부모 단 user 글, 마지막 글은 assistant 줄이 아니라 `task_notification.summary` 로 온다.
- `task_started`(tool_use_id · is_backgrounded) · `task_progress`(description · usage{tool_uses, duration_ms} · last_tool_name) · `task_updated`(**tool_use_id 없음**) · `task_notification`(status · summary · usage). status 값 `completed · failed · stopped` 는 실행 파일 안 스키마에서 읽었다. `task_type: local_bash`(백그라운드 셸)도 같은 사건을 낸다.
- Agent 도구 결과의 끝 3줄은 `agentId: … <usage>…` 기계 글이다.

## 만든 것
- **이벤트**(`src/shared/chat.ts`): `tool` 에 선택 칸 `parent`. 새 종류 `agent`(id = Agent 도구 id · phase start/progress/end · bg · doing · tools · last · ms · status · summary). `isChatEvent` 가 선택 칸의 타입까지 보고, `redactEvent` 가 doing · last · summary 를 가린다. summary 는 1000자로 자른다.
- **변환**: 부모 단 assistant 줄은 tool_use 만 `tool{parent}` 로, 글 · 생각 · 오류는 버린다(하위 실패는 알림 status 로). tool_result 는 부모와 무관하게 지금처럼. `task_updated` 는 버린다 — tool_use_id 가 없고, 같은 상태가 알림으로 바로 뒤에 온다(실측 2회).
- **접기**(`foldBlocks`): Agent · Task 도구는 도구 묶음에 넣지 않고 새 블록 `agent`. 부모 단 도구는 그 카드의 `sub` 로(부모를 모르면 버림 — 본 흐름에 섞지 않는다). `agent` 사건은 id 로 카드를 찾아 Agent · Task 이름일 때만 반영 — 턴이 끝나고 다음 글을 보낸 뒤 온 알림도 맞는 카드를 채운다. 포그라운드는 Agent 도구 결과가 오면 알림이 없어도 닫고(백그라운드의 결과는 '맡겼다' 는 답), 멈춤은 포그라운드만, 갑자기 끝남(crash · missing)은 백그라운드까지 '멈춤' 으로. 나중에 진짜 알림이 오면 그것이 이긴다.
- **카드 글자**(`agentCard`): 상태(진행 중 · ✓ 끝남 · ✕ 실패 · 멈춤) · 진행 줄(하는 일 · 도구 N번 · 마지막 X · 걸린 시간 — 끝나면 하는 일은 지움) · 끝난 뒤 요약.
- **끝을 못 받은 하위 작업 닫기**: `ClaudeSession` 이 시작했는데 알림이 없는 id 를 기억해 프로세스가 끝나거나(`ended`) 갈라 띄우며 떼어 낼 때(`fork`) `agent{end, stopped}` 를 낸다. 앱이 그 표시를 쓰기 전에 끝나거나 죽었으면 `ChatManager.history()` 가 다시 열 때 `openAgents` 로 찾아 닫는다(열린 턴을 '멈춤' 으로 닫는 21단계 방식 그대로, 한 번만).
- **anchor**: `ClaudeSession.lastUuid` 는 부모 없는 assistant 줄만 받는다.
- **화면**(`ChatPane.tsx` · `styles.css`): Agent 카드 — 머리(이름 · 설명 · '백그라운드' · 상태) · 진행 줄 · 요약(넘치면 160px 안에서 스크롤) · '하위 도구 N개' 펼치기(`aria-expanded`, 24px 높이) · 하위 에이전트가 고친 파일의 'diff 열기' 카드. 간격은 `--space-*`, 글자 12px 이상. 원격 패널(`RemotePanel.tsx`)은 모르는 블록을 '대화 중지됨' 으로 그리던 마지막 줄에 걸리지 않게 agent 블록을 `<details>` 로 그린다.
- **가짜 claude**(`tests/fixtures/fake-claude.mjs`): e2e 용 대본 `subagent`(포그라운드 · Read 하나 · 부모 단 중간 글) · `bgagent`(백그라운드 — 턴 끝 뒤 진행 · 알림). 단위 시험이 실제 node 프로세스로 adapter 에 물려 한 번 받아 본다(앱은 띄우지 않음).

## 옛 기록 · 순서에 기대는 곳
- 68 전 기록(`<userData>/chat/*.jsonl`)은 그대로 읽힌다. Agent 없는 기록은 접은 결과가 전과 같다(68 전 코드로 접은 결과를 시험에 고정). Agent 가 있는 옛 기록은 진행 없는 Agent 카드가 되고, 섞여 기록된 옛 하위 도구는 부모 정보가 없어 본 흐름에 남는다.
- 카드는 끝 3줄(tail)을 보이지 않는다 — Agent 도구 결과의 끝은 `agentId … <usage>` 기계 글이고 요약은 알림이 준다. 옛 기록의 Agent 카드는 상태만 보인다.
- 새 기록을 옛 앱(0.2.0)이 읽으면 `agent` 줄은 버려지고 화면은 그대로지만, 옛 앱의 대화 기록 검색은 모르는 줄이 든 대화를 '읽지 못함' 으로 건너뛴다. 원격 서버는 같은 버전을 요구한다(`docs/remote-workspaces.md`). 되돌려 깔 일이 드물어 받아들였다.
- 되감기 · 나누기(`rewindPlan`)는 user · turn_end · session · text 만 본다 — `agent` 는 세지 않고 지나간다. 잘린 뒤 늦게 온 알림은 모르는 id 라 버려진다. `lastTurnText`(CLI `chat wait/read`) · 워크플로 단계 결과 · 알림 본문은 text 만 모으므로 하위 에이전트 글이 더는 섞이지 않는다. `chatStatus` 는 `agent` 를 보지 않는다.

## 검증
- `FULL_CHECK_NO_E2E=1 full-check.sh` 종료 4 — typecheck · 경계 · 간격 · 단위 **1,610개 통과**(새 시험 16), **e2e 미실행(사용자 지시)**.
- 새 단위 시험: `chat.test.ts` 9(실측 재료 · 진행 · 알림 · 자르기 · 가림 · 모르는 id · 백그라운드 · 멈춤 · 옛 기록 · 모양 검사) · `chat-adapter.test.ts` 4(anchor · 하위 작업 닫기 · 가짜 대본 둘) · `chat-manager.test.ts` 2 · `chat-store.test.ts` 1.
- 변이 10개(`mutation-check.sh --batch`) — 모두 잡음. 처음 둘(부모 단 줄을 본 흐름으로 · foldBlocks 가 parent 를 안 봄)은 조건을 `false` 로 바꾸니 컴파일이 깨져 판정 불가 → 옛 구조를 재현하는 값 변이(parent 칸을 안 붙임 · 있을 수 없는 id 와 비교)로 다시 돌려 잡음. 나머지: Agent 를 도구 묶음에 · Agent 아닌 도구에 진행 · 백그라운드를 tool_end 로 닫음 · 멈춤이 백그라운드까지 · 요약을 안 가림 · 하위 줄 uuid 가 anchor · 프로세스 끝에 안 닫음 · 다시 열 때 안 닫음.
- UI(코드로): 펼치기는 native button + `aria-expanded`, 이름은 '하위 도구 N개'(화살표는 `aria-hidden`). 상태는 글자 + 색(색만으로 뜻을 전하지 않음). 머리 설명은 넘치면 말줄임 + `title`. 요약 상자는 넘치면 스크롤 — Electron 45(Chromium 130 이후)는 스크롤 상자를 키보드로 갈 수 있다. 진행이 바뀌어도 화면 읽기 알림은 하지 않는다(기존 도구 묶음과 같음).

## 계획과 다르게 한 것
- 변이 두 개를 계획의 '조건 끄기' 대신 값 변이로 다시 돌렸다(위 검증 — 컴파일이 깨져 판정 불가였다).
- 계획에 없던 것: 펼치기 단추 `min-height: 24px`(포인터 영역), 하위 에이전트가 고친 파일의 'diff 열기' 카드 유지(68 전에는 섞인 도구 줄이 카드를 냈다 — 기능을 잃지 않으려고), `ChatStore` 옛 줄 + 새 줄 읽기 시험.
- 그 밖은 없음.

## 범위 밖 · 안 한 것
- Codex 의 하위 작업: app-server 의 하위 작업 항목 줄을 로그인한 codex 로 본 적이 없다(22단계부터 승인 · 항목 줄도 미확인) — 모양을 모르는 채 만들지 않았다.
- 하위 에이전트 안쪽 대화 전문 보기(지시 · 중간 글 · output_file 읽기).
- `task_updated` 의 포그라운드 → 백그라운드 옮김(tool_use_id 가 없다, -p 모드에 옮기는 손이 없다).
- 백그라운드가 도는 동안 머리 칩 · 사이드바 상태 바꾸기, 걸린 시간을 초마다 세기(마지막 진행 사건의 값을 보인다), 하위 작업 다시 시도 단추.

## 미검증
- **백그라운드 하위 에이전트의 실제 줄 순서**(알림이 턴 뒤에 오는지 · 그 사이 본 에이전트가 새 턴을 여는지)는 실측하지 않았다 — 실행 파일 스키마와 지시서에 기댄 추론이다. 실제 계정 1회가 더 필요하다.
- 하위 에이전트에서 오는 허락 요청(control_request)이 본 흐름의 허락 카드로 잘 보이는지, 중첩 하위 에이전트(spawn_depth 2)의 줄 — 실측 없음(지금은 부모를 아는 하위 도구 아래로 붙고, 화면은 '하위 도구 N개' 숫자만).
- 실제 화면(좁은 pane · 라이트/다크 · 큰 글자)은 앱을 띄우지 않아 못 봤다.

## 돌려야 할 e2e (사용자 지시로 이번에는 돌리지도 쓰지도 않음)
1. 가짜 claude 에 `subagent` 를 보내면 Agent 카드가 보이고, 본 흐름에 Read 도구 묶음 · '하위 에이전트 중간 글' 이 없고, '하위 도구 1개' 를 펼치면 Read 줄 · 상태 '✓ 끝남' · 요약 '1줄이에요'.
2. `bgagent`: 끝남 줄 뒤에 카드가 '진행 중' · '백그라운드' → 1초 안에 '✓ 끝남' · 요약.
3. `bgagent` 를 보내고 알림 전에 앱을 끝냈다 다시 열면 카드가 '멈춤'(history 닫기).
4. `subagent` 턴 뒤 '여기로 되감기' · '여기서 새 대화로 나누기' 가 본 줄 anchor(`u-…`)로 가른다(가짜 claude 로그의 `--resume-session-at`).
5. 좁은 pane(320px)에서 카드 머리 글이 넘치지 않음 · 라이트/다크 대비 · Tab 으로 펼치기 단추 · Enter/Space.
6. 원격 패널 대화의 agent 블록이 '대화 중지됨' 이 아니라 `<details>` 로 보임.
