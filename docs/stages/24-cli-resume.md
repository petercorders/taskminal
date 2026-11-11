# 24단계 — 지휘와 이어받기

`docs/plan.md` 24 줄: CLI 소켓 기본(`taskminal` 명령 · task/pane/notify — CLI 보드) + chat new/send/wait/read → 여러 에이전트 지휘 (Chat) + 이어받기 요약 · 일감 메모 · `taskminal task note` (Resume).
verify: e2e — CLI 로 대화 2개 띄우고 wait · 30분 지난 일감 열면 요약 카드 맨 위 '확인 필요'.
보드: CLI · Chat(5 여러 에이전트 지휘) · Resume. 브랜치 `stage-24-cli-resume`. 커밋은 24a CLI(소켓 · 명령 · 지휘) → 24b 이어받기(메모 · 요약 카드)로 나눈다.

plan-check: 서버 없음 — 앱이 여는 것은 같은 사용자만 쓰는 로컬 유닉스 소켓(`<userData>/cli.sock`)과 상태 파일뿐, 원격 요청은 없다

## 0. 스파이크 결과 (2026-11-11)

| 미확인 (보드) | 돌려 본 것 | 결과 |
|---|---|---|
| TUI 에이전트의 '마지막 말'(OSC 9) | 이 Mac 의 Claude Code 2.1.322 실행 파일에서 알림 길 코드를 읽음(`preferredNotifChannel` 처리부) | 기본값 `auto` 는 `TERM_PROGRAM` 이 `Apple_Terminal` · `iTerm.app` · `kitty` · `ghostty` 일 때만 보낸다 — 우리 셸은 `TERM_PROGRAM=Taskminal` 이라 `no_method_available`(아무것도 안 보냄). `iterm2` 로 바꾸면 OSC 9 가 오지만 글은 'Claude 가 입력을 기다려요' 같은 **알림 문구**지 마지막 말이 아니다. → **TUI 의 마지막 말은 OSC 9 로 얻지 않는다**. 마지막 말 = 대화 pane 의 턴 끝 글(구조화 이벤트), TUI 에이전트는 `taskminal task note` 로 인계 메모를 남기게 한다(`taskminal help` 에 적음). OSC 9 가 오면 지금처럼 '확인 필요' 의 이유 글로만. codex 는 이 Mac 셸 PATH 에 없어 **미확인** |
| 소켓 권한 | node 로 임시 폴더에 유닉스 소켓: `umask(0o077)` 로 listen → `stat` · 접속 · 앱이 죽은 뒤 남은 소켓 파일 | 소켓 파일 모드 `srwx------`(700) · 폴더 700 → 같은 사용자만. 콜백 전에 umask 를 되돌려도 모드는 그대로. 죽은 프로세스의 소켓 파일은 남는다 → 접속 `ECONNREFUSED`, 그 경로에 다시 listen 은 `EADDRINUSE` → **지우고 다시 연다**(앱은 `requestSingleInstanceLock` 이라 같은 userData 의 다른 앱이 없다). 경로가 104바이트를 넘으면 지킴이처럼 `<tmp>/taskminal-<해시>-cli.sock`. 다른 사용자의 접속 시험은 이 Mac 에 계정이 하나라 **미확인**(모드로만 막는다) |

## 1. 범위

### 이렇게 만든다 (보드 → 할 일)
| 보드 | 할 일 |
|---|---|
| CLI 1 앱이 소켓을 연다 | main `src/main/cli-server.ts` — `<userData>/cli.sock`(0600, umask 077 로 listen), 한 연결 = 한 요청(줄 JSON `{op, …, self}` → `{ok, …}` 또는 `{ok:false, error, code}`). 앱이 꺼져 있으면 CLI 가 '앱이 실행 중이 아니에요'(종료 코드 3) |
| CLI 2 터미널마다 환경 변수 | 셸 · 대화 에이전트에 `TASKMINAL_PANE_ID` · `TASKMINAL_SOCKET` · `TASKMINAL_CLI_NODE` · `TASKMINAL_CLI_JS` 와 PATH 끝에 `taskminal` 폴더. `TASKMINAL_TASK_ID` 는 main 이 받은 마지막 상태에서 찾을 수 있을 때만(띄우는 순간에는 상태가 아직 안 왔을 수 있다 — pane id 만으로 일감을 찾으므로 없어도 된다) |
| CLI 3 앱 화면에 바로 반영 | 일감 · 탭 · pane 을 바꾸는 명령은 main → 창(`cli:request`) → renderer 가 사람이 누를 때와 같은 reducer 동작 → 답(`cli:reply`). pane 의 입력 · 출력 · 기다리기는 main 이 셸 지킴이로 직접(이름 → id 는 renderer 가 풀어 준다) |
| CLI 4 Claude 가 알게 하기 | 앱이 Claude Code skill 파일을 사용자 `~/.claude` 에 쓰는 것은 **하지 않는다**(사용자 Claude 설정을 바꾸지 않는다). 대신 `taskminal help` 가 명령 · 끝날 때 `task note` · 확인이 필요하면 `notify` 를 알려 준다 |
| 명령 (보드 표 10개 + 대화 4개 + 메모) | `list [--json]` · `task new <이름> [--cwd] [--template] [--group] [--status]` · `task move [<일감>] [--status] [--group]` · `task open\|rename\|color\|remove` · `task note [<일감>] "글"` · `tab new [<일감>] [--template] [--cmd] [--title]` · `pane split [<pane>] --right\|--down [--cmd]` · `pane send <pane> "글" [--enter]` · `pane read <pane> [--lines 50] [--json]` · `pane wait <pane> --for idle\|prompt\|exit\|text:"…" [--timeout 10m] [--quiet 3s]` · `notify [--task <일감>] "글"` · `chat new [--agent claude\|codex] [--task] [--right\|--down\|--tab] "글"` · `chat send <pane> "글"` · `chat wait <pane…>\|--all [--timeout]` · `chat read <pane> [--last 1] [--json]` · `help` · `--version` |
| `<일감>` · `<pane>` 가리키기 | 일감 = id · 이름(같음 → 대소문자 무시 같음). pane = pane id · `일감` (활성 탭의 활성 pane) · `일감:탭`(탭 이름 = `tabLabel` 또는 1부터 번호). 겹치면 오류와 후보 목록(종료 코드 2), 생략하면 이 터미널의 pane · 그 일감 |
| 이름 → id 를 푼 pane 은 띄운다 | 이 실행에서 한 번도 안 연 탭의 pane 이면 그 탭을 숨긴 채 띄운다(`seenTabs`) — 셸 · 대화가 떠야 보내기 · 읽기 · 기다리기가 된다. 셸이 뜰 때까지 5초 기다린다 |
| `pane wait` | `src/shared/pane-watch.ts`(순수, 시계를 받음) — main 이 지킴이 출력 길에서 OSC 133(A · C · D;코드)을 읽고 마지막 출력 시각을 센다. `exit` = 지금 도는 명령(또는 `--cmd` 로 만든 pane 의 첫 명령)이 끝날 때 → 종료 코드, 도는 것이 없으면 바로 마지막 결과. `prompt` = 셸이 입력을 기다릴 때(셸 통합이 없으면 오류로 idle 을 권함). `idle` = `--quiet`(기본 3초) 동안 출력 없음. `text:"…"` = 지금 화면 끝 50줄 또는 그 뒤 출력에 그 글이 나옴. 셸이 끝나면 어느 것이든 '셸이 끝났어요'. 시간 초과 → 종료 코드 124 |
| `pane read` | 지킴이 headless 화면의 끝 n 줄(1~1000) → **가린 뒤**(`redact`, 디스크와 같은 규칙) |
| `notify` | 그 일감에 `notice{text, at}` → 사이드바 '확인 필요' · Dock 배지 · macOS 알림(설정의 '입력 기다림' 알림 방식). 사용자가 그 일감을 보면 지운다 |
| Chat 5 여러 에이전트 지휘 | `chat new` = 그 일감에 대화 pane(오른쪽 나누기 · 아래 · 새 탭, 탭이 없으면 새 탭) → main 이 첫 글을 바로 보낸다(화면이 열려 있지 않아도). `chat send` = 그 대화에 보냄(실행 중이면 '실행 중이에요'). `chat wait` = 턴이 끝나거나 허락 · 질문을 기다릴 때까지 — `--all` = 그 일감의 대화 pane 모두(부르는 pane 은 빼고). `chat read` = 마지막 턴의 에이전트 글(가린 것) |
| Chat 5 '맡긴 대화' 카드 · 노란 줄 | **하지 않는다**(아래 '하지 않는 것') — 맡긴 대화는 사이드바 · 탭에서 보이고, 허락은 그 대화 pane 에서 |
| Resume 1 메모 · 본 때 | `Task.notes?: Note[]{id, text, done?, by?:'agent', at}` · `Task.lastViewedAt?` · `Task.notice?` — 옛 파일은 빈 값으로 읽음(형식 번호는 그대로 1, 모르는 칸을 버리는 검증이라 옛 앱이 읽어도 깨지지 않는다) |
| Resume 2 명령 기록 | 19단계 `history` 를 그대로 쓴다 |
| Resume 3 카드 = 규칙으로 모은 사실 · 5줄 | `src/shared/resume.ts` `resumeCard(input)` — 맨 위 한 줄 = 확인 필요 → 에이전트 인계 메모 → 내 첫 할 일. 아래는 확인 필요 → 실패 → 실행 중 → 에이전트 말(대화 pane 마지막 턴 글) → 바뀐 파일(변경 검토의 `review.load` 수) 순, 5줄 넘으면 '외 n개 · 명령 기록(⌘Y)에서 보기' |
| Resume 4 언제 · 다시 열기 | 본 지 30분(설정) 넘고 그 사이 새 사실(확인 필요 · 끝난 명령 · 에이전트 말 · 에이전트 메모)이 있으면, 일감을 고를 때 · 창에 다시 돌아올 때 · 앱이 처음 읽힐 때. 처음 한 번 '30분 넘게 안 본 일감이라 그 사이 일을 모았어요'. ✕ · Esc → '요약을 닫았어요 · 다시 보기' 3초, '↺ 요약'(⌥⌘R) · ⌘P 로 다시 |
| Resume 5 키보드 · ⌘P | 카드가 뜨면 포커스 — ↑↓ · ↩ 그리로(터미널 보기 · 대화 보기 · 변경 보기 · 메모 열기) · Esc. ⌥⌘M 메모. ⌘P '이 일감 메모 열기' · '이어받기 요약 다시 보기' |
| Resume 6 AI 요약 | **하지 않는다**(아래) — 단추도 두지 않는다 |
| Resume 7 셸이 끝났을 때 | 지킴이가 없어 13단계 되살리기로 열린 pane 은 '앱이 꺼진 사이 끝남'(복원된 pane) 한 줄 — 지킴이(16단계)가 있으면 셸이 이어지므로 드물다 |
| Resume ↔ | `task note` → 카드의 '다음 할 일'(Claude 가 남김) · 대화 턴 끝 글 = 마지막 말 · 변경 검토 파일 수 · 단추 이름 '터미널 보기 · 대화 보기 · 변경 보기' |
| 메모 칸 | 탭 줄 오른쪽 '✎ 메모 · 할 일 n' 으로 여닫는 칸(따로 창 없음). 줄마다 체크 칸 · 지우기, 아래 입력칸 ↩ 로 더함. 에이전트 줄은 '에이전트가 남김'. CLI 는 덧붙이기만(사람이 쓴 줄을 못 고친다) |
| 설정 | 일반 › '이어받기 요약' 켜기 · 몇 분 뒤(기본 30) |
| 명령줄 도구 설치 | 앱 메뉴 '명령줄 도구 설치…' — `/usr/local/bin/taskminal` 심볼릭 링크를 사용자가 눌러서만 만든다. 쓸 수 없으면 직접 칠 `sudo ln -s …` 를 보여 주고 복사 단추. 시험은 `TASKMINAL_CLI_INSTALL_DIR` |

### 정할 것 (추천안으로 정함)
- 한 연결 = 한 요청(오래 기다리는 `wait` 도 그 연결에서). CLI 가 끊으면 main 이 기다림을 버린다.
- 화면 상태를 바꾸는 일은 renderer, 셸 입출력 · 기다리기 · 대화 보내기는 main(지킴이 · ChatManager). renderer 는 '이름 → id · 필요하면 띄우기' 만 답한다.
- `pane read` · `chat read` · `wait text` 의 찾은 줄은 늘 가린다(에이전트로 가는 길 = 디스크와 같은 규칙). `--raw` 는 두지 않는다.
- CLI 로 만든 pane 은 그 일감의 활성 pane 이 된다(사람이 나눌 때와 같다). 지금 보는 일감이 아니면 화면은 바뀌지 않는다.
- `task remove` 는 화면의 지우기와 같은 길(알림 '되돌리기 ⌘Z')이지만, 실행 중인 명령이 있으면 `--force` 없이는 거절.

### 설계
| 파일 | 내용 |
|---|---|
| `src/shared/cli.ts` (순수) | `parseArgs(argv)` → `CliRequest` 또는 사용법 오류 · `parseDuration('10m')` · `isCliRequest(v)`(main 이 소켓에서 받은 값 검사) · `resolveTask(state, ref, selfPaneId)` · `resolvePane(state, ref, selfPaneId)` → `{ok, …}` 또는 `{error, candidates}` · `listRows(state, activity, now)` · `formatRows` · `HELP` |
| `src/shared/pane-watch.ts` (순수) | `OscScanner` — 조각난 출력에서 OSC 133 사건 · 화면 글(ANSI 뺌)을 뽑는다(끊긴 꼬리는 다음 조각에 붙임) |
| `src/shared/pane-watch.ts` `PaneWatch` | pane 마다 `{running, lastCode, lastOutputAt, exited}` · `wait(paneId, cond, {timeoutMs, quietMs, pending})` → `{result, cancel}` |
| `src/main/cli-server.ts` | 소켓 · 요청 검사 · 창에 묻기(5초, 창이 없으면 '창이 없어요') · pane/chat 의 main 쪽 일 |
| `src/main/cli/cli-entry.ts` | `out/main/cli.js` — 인자 → 소켓 → 출력 · 종료 코드(0 · 1 오류 · 2 사용법/찾지 못함 · 3 앱 꺼짐 · 124 시간 초과) |
| `resources/bin/taskminal` | sh — `TASKMINAL_CLI_NODE`/`_JS`(앱이 넣은 정확한 경로)가 있으면 그것, 없으면 자기 위치(링크를 따라감)에서 `.app` 이나 저장소를 찾아 `ELECTRON_RUN_AS_NODE=1` 로 |
| `src/renderer/cli-bridge.ts` | `handleCliUi(req, ctx)` — 상태 · 활동으로 답과 할 동작(dispatch 목록 · 띄울 탭 · 지우기)을 만든다(순수, 단위 시험) · App 이 동작을 실행 |
| `src/shared/resume.ts` (순수) | `resumeCard` · `shouldShowResume` |
| `src/shared/model.ts` · types | `Note` · `notes` · `lastViewedAt` · `notice` 검증 · `addNote(task, note, by)` · `toggleNote` · `removeNote` · `setViewed` |
| `src/renderer/ResumeCard.tsx` · `NotesPanel.tsx` | 카드 · 메모 칸 |
| electron.vite main 입구 `cli` · electron-builder `extraResources: resources/bin → bin` | |

### 가린 사본이 닿는 곳 (rc2deda)
| 길 | 무엇이 가나 |
|---|---|
| `pane read` 출력 · `pane wait text` 의 찾은 줄 | **가린 것**(디스크와 같은 `redact`) — 다른 에이전트 · 그 API 로 가는 길 |
| `chat read` | 대화 기록 파일(이미 가린 것) |
| `list` 의 명령 글 | 가린 것(19단계 기록과 같은 규칙) |
| `pane send` · `chat send` 의 글 | 원문 그대로 셸 · 에이전트로(사용자 · 에이전트가 친 글) |
| `notify` 글 · `task note` 글 | 상태 파일에 **가린 뒤** 저장(디스크) · 화면은 화면 가리기 설정(작은 고침의 명령 글과 같음) |
| 요약 카드 사실 줄 | 기록(가린 것) · 대화 기록(가린 것) · 활동 글은 화면 가리기 설정 |
| macOS 알림(`notify`) | 늘 가린 것(알림 센터에 저장 — 작은 고침의 규칙) |

### 칸 (plan-check · 계획 규칙)
- **결과를 모를 때**: CLI 가 소켓에 보냈는데 답 전에 앱이 끝나거나 연결이 끊기면 CLI 는 '앱과 연결이 끊겼어요 — 반영됐는지 `taskminal list` 로 확인' (종료 코드 1). main 이 창에 물었는데 5초 안에 답이 없으면 '앱 화면이 답하지 않아요'(창은 그 뒤에 해도 늦은 답은 버린다 — 요청 번호).
- **다시 시도**: 같은 CLI 를 다시 부르면 된다. `task new` · `chat new` 는 다시 부르면 하나 더 만든다(멱등 키 없음 — CLI 는 사람이 · 에이전트가 결과를 보고 부른다). `pane send` 는 다시 보내면 두 번 친다.
- **이중 입력**: 같은 pane 에 `chat send` 가 둘 겹치면 두 번째는 '실행 중이에요'(main 의 busy). 기다리기가 둘이면 서로 따로 기다린다.
- **취소 · 닫기**: CLI 를 Ctrl-C 로 끊으면 main 은 그 연결의 기다림을 버린다(타이머 · 듣는 이 정리). 창이 닫히면 창에 묻는 요청은 '창이 없어요'. 메모 칸 · 카드를 닫으면 아무것도 쓰지 않는다.
- **고른 뒤 나중에 실행(r4ee705)**: 카드의 사실 줄은 pane id 로 들고, ↩ 때 그 pane 이 아직 있는지 다시 찾는다(없으면 일감만 연다). 메모 줄 체크 · 지우기는 id 로. CLI 의 이름 → id 를 푼 뒤 main 이 pane 에 쓰기 전에 그 pane 이 사라졌으면(셸 없음) '그 터미널이 없어요'.
- **늦게 도착하는 옛 응답 · 세대**: 창에 묻는 요청마다 번호 — 시간이 지난 번호의 답은 버린다. 요약 카드는 일감을 고를 때마다 세대를 올려, 늦게 온 비동기(대화 기록 · git) 결과가 다른 일감의 카드에 붙지 않게 한다.
- **부수 요청**: 카드는 '고를 때 · 창에 돌아올 때 · 처음' 에만 계산하고 주기로 돌지 않는다. 계산 중에 또 부르면 앞 것을 버린다(세대). `lastViewedAt` 은 일감을 떠날 때 · 창이 뒤로 갈 때 · 보는 동안 5분마다만 쓴다(안 보일 때는 쓰지 않는다 · 포커스 동안만).
- **처음 한 번만 읽는 값**: main 의 가리기 옵션은 상태를 받을 때마다 바꾼다(이미 있는 `secretOpts`). CLI 서버가 쓰는 '마지막 상태'(TASK_ID 찾기)도 상태 저장마다 바꾼다 — 처음 한 번 읽은 값을 쓰지 않는다.
- **끝 표시 전에 앱이 끝남**: `chat wait` 는 대화 기록(jsonl)을 읽어 열린 턴인지 본다 — 앱이 턴 도중 끝나 기록이 열린 채 남은 대화는 21단계 `history()` 가 다시 열 때 '멈춤' 으로 닫는다. CLI 서버도 같은 `history()` 를 거쳐 읽으므로 '실행 중' 에 굳지 않는다(시험).
- **앱 종료 4경로**: ① 앱 종료 — 소켓을 닫고 파일을 지운다, 기다리던 CLI 는 '연결이 끊겼어요'. ② 창 닫기 — 소켓은 남고 창에 묻는 요청만 '창이 없어요'(셸 일은 된다). ③ 새로 고침 · ④ 렌더러 충돌 — 그 사이 온 요청은 5초 기다림 뒤 실패, 다시 읽힌 창이 받는 이를 다시 단다.

### 시험
단위
- `cli.test.ts`: 인자 해석(모든 명령 · 빠진 값 · 모르는 옵션 · `--timeout 10m` · `text:"…"`) · 요청 검사(모양이 틀리면 거절) · `resolveTask`(id · 이름 · 대소문자 · 겹침 후보 · 생략 → 자기 일감 · 자기 pane 없음) · `resolvePane`(id · `일감` · `일감:탭` 이름 · 번호 · 없음) · `listRows`(상태 순서 · 명령 가림 · ← 여기).
- `pane-watch.test.ts`: 조각난 `\x1b]133;D;2\x07` · `ESC \` 끝 · 글자 뽑기.
- `pane-watch.test.ts`: exit(도는 중 → D 코드, 도는 것 없음 → 바로, `--cmd` pane 첫 명령) · prompt · idle(가짜 시계) · text(화면 · 뒤 출력) · 셸 끝 · 시간 초과 · 취소.
- `cli-server.test.ts`: 소켓 0600 · 남은 소켓 지우고 열기 · 줄 JSON 왕복 · 창 없음 · 창 답 시간 초과 · 끊긴 연결의 기다림 버림.
- `resume.test.ts`: 맨 위 줄 순서 · 5줄 넘침 · 새 사실 없으면 안 뜸 · 30분 기준 · 실패 묶음.
- `model.test.ts`: notes · notice · lastViewedAt 검증 · `addNote`(에이전트는 덧붙이기만) · 옛 파일.
e2e (`tests/e2e/cli.spec.ts` · `resume.spec.ts`, 저장소의 `resources/bin/taskminal` 을 셸에서 부름)
1. pane 안에서 `taskminal list` → 자기 줄 '← 여기' · `--json`.
2. **verify**: 셸에서 `taskminal chat new "…"` 두 번(가짜 claude) → `chat wait --all` 이 둘 다 끝날 때까지 기다림 → `chat read` 가 가짜의 답.
3. `pane split --cmd 'sleep 1; echo DONE'` → `pane wait --for exit` → `pane read` 에 DONE · `task move --status 대기` 가 사이드바에 반영 · 겹치는 이름 오류.
4. `notify "…"` → 사이드바 확인 필요 칸에 그 일감 · `task note "…"` → 메모 칸에 '에이전트가 남김'.
5. 앱이 꺼진 소켓 → 종료 코드 3 · 소켓 파일 모드 0600.
6. **verify**: lastViewedAt 31분 전 + 그 사이 입력 기다림(벨) pane 이 있는 일감을 고르면 카드 맨 위 '? 확인 필요' · Esc → '다시 보기' · ⌥⌘R(메뉴) 로 다시.
7. 메모 칸: 더하기 · 체크 · 껐다 켜도 남음 · 할 일 수.
8. 명령줄 도구 설치(임시 폴더로) → 링크가 그 폴더에.

### 순서 → verify
1. 스파이크(위) → 이 문서.
2. shared `cli.ts` · `pane-watch.ts` 시험 → 구현 → vitest.
3. main `pane-watch.ts` · `cli-server.ts` · `cli-entry.ts` · 환경 변수 · 빌드 입구 → 단위 + 손으로 소켓.
4. renderer `cli-bridge.ts` · App 연결 · notice · e2e 1~5 → 24a 커밋.
5. 메모 · 요약 카드 · 설정 · 키 · e2e 6~8 → 스크린샷 → 24b 커밋.
6. 변이 확인(핵심 줄) → 전체 검사 → `/code-review medium` → 고침 커밋 → 전체 검사 → 문서 · 병합 · 회고.

## 하지 않는 것
- AI 요약(⌥⌘S · 토큰 사용량) — 누를 때만 쓰는 기능이고 사용량 보드(design-gaps 5)가 없다. 다음 단계 또는 디자인 맞추기에서.
- 지휘하는 대화 안의 '맡긴 대화' 카드 · 노란 줄에서 바로 허락 · '나눠 전하기' — 대화 pane 화면 개편이 크다. 맡긴 대화는 각 pane · 사이드바에서 본다.
- Claude Code skill 파일 설치(사용자 `~/.claude` 를 바꾸지 않는다) · PATH 에 자동 설치(메뉴로만).
- 일감 사이 메모 검색 · 메모 동기화 · 첨부 · 마크다운 렌더.
- `task new --template` 의 템플릿 시작 명령은 그대로 돈다(새 일감 대화상자와 같음) — CLI 전용 옵션 없음.

## 계획과 다르게 한 것
- `notify`: 저장되는 `Task.notice` 대신 대상 pane 의 런타임 활동 알림(`notify` 사건 = 기존 확인 필요 · Dock 배지 · macOS 알림)으로 했다. 칸 하나 · 지우는 길(보면 꺼짐)을 기존 활동이 이미 가져서다. 앱을 다시 켜면 사라진다 — 오래 남길 말은 `task note`.
- `TASKMINAL_TASK_ID`: main 이 받은 마지막 상태에서 찾을 수 있을 때만(계획대로) — 일감 찾기는 pane id 로 한다.
- `task new` 는 사용자가 보던 일감으로 되돌린다(에이전트가 만든 일감이 화면을 빼앗지 않게). `tab new` · `pane split` 은 사람이 누를 때처럼 그 탭 · pane 을 활성으로 바꾼다.
- `chat read` 는 마지막 턴만 — `--last n` 옵션은 만들지 않았다(마지막 턴이 아닌 글은 대화 pane 에서 본다).
- 요약 카드 '바뀐 파일' 줄: `review.load` 를 카드 계산 때 부르지 않았다 — 고를 때마다 git 을 돌리게 되고, 그 비동기 결과를 세대로 막을 필요가 생긴다. 줄 종류 · 단추('변경 보기')는 순수 함수에 있고 수는 넘기지 않는다(`changed` 없음 = 줄 없음). 그래서 카드 계산은 모두 동기 — 계획의 '세대' 칸은 쓰지 않았다.
- 요약 카드 '셸이 끝났을 때'(Resume 7) 줄은 만들지 않았다 — 16단계 지킴이가 셸을 이어 주고, 지킴이 없이 되살린 pane 은 이미 시작 안내 줄('폴더와 이전 출력은 되살렸지만 돌던 명령은 끝났어요', host-ui)이 알린다.
- 앱이 처음 읽힐 때 카드: 지킴이의 '꺼져 있던 동안 생긴 확인 필요' 가 조금 늦게 들어오므로, 그것이 들어오면 한 번 더 본다(`evalResume('late')`, 이미 뜬 카드는 그대로).
- '↺ 요약' 은 탭 줄 오른쪽 단추(다시 볼 카드가 있을 때만) · ⌥⌘R · ⌘P · 보기 메뉴.
- `pane-watch` 는 main 이 아니라 shared 의 순수 모듈 하나(`OscScanner` + `PaneWatch`, 시계 주입)로 — 시간 · 순서를 단위 시험에서 가짜 시계로 보려고. `osc-scan.ts` 는 따로 두지 않았다.
