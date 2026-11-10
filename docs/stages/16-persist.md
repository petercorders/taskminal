# Taskminal 16단계 — 셸 지킴이 (앱을 꺼도 셸이 살아 있기)

## Context
docs/plan.md 16단계 · 보드 Persist.dc.html(추천안 채택, 2026-11-11). 지금은 앱 종료 · 창 닫기 · 새로 고침 · 렌더러 충돌 네 경로가 모두 셸을 끝낸다(main `PtyManager` 가 node-pty 를 가짐).
verify: e2e — 셸에서 `sleep 600` → 앱 종료 · 재실행 → 같은 pid 로 다시 붙고 출력 이어짐 · ⌥⌘Q 뒤 고아 셸 0 · 지킴이 죽이면 13단계 복원으로 내려감.
사용자 지시: 16~25 묻지 않고 진행, 선택은 보드 추천안.

## 스파이크 (2026-11-11, 계획 첫 순서로 돌림)
| 질문 | 결과 |
|---|---|
| detached 자식이 앱 종료 뒤 사나 | Electron main 에서 `spawn(process.execPath, [host.js], {detached, stdio:'ignore', env: ELECTRON_RUN_AS_NODE=1}).unref()` → `app.quit()` 뒤에도 · main 을 `kill -9` 해도 지킴이 · 그 안 셸이 살고, 소켓으로 다시 붙어 명령이 돈다 |
| 지킴이 안 node-pty · 패키지 경로 | dev(node_modules) · 패키지 모두 뜬다. **패키지는 `app.asar/node_modules/node-pty` 로 require 해야 한다** — `app.asar.unpacked/...` 로 직접 require 하면 helper 경로가 `.unpacked.unpacked` 가 되어 `posix_spawnp failed`(번들된 host.js 가 그냥 `require('node-pty')` 하면 app.asar 경로로 풀림) |
| headless 메모리 (120칸, 1만 줄 출력) | scrollback 1만: pane 20 = 416MB · 100 = **1.6GB** / 3000: 147 · 644MB / 1000: 66 · 265MB — 줄당 약 2.2KB. 쓰기 100 pane × 1만 줄 1초, serialize 5~50ms |
| .app 이 바뀐 뒤 옛 지킴이 | 번들을 옮기고 새 것을 놓아도 옛 지킴이 · 옛 셸 그대로, 새 셸도 뜸(같은 경로의 새 spawn-helper). **번들이 지워진 채면 옛 셸은 살지만 새 셸은 `posix_spawnp failed`** → 새 셸은 언제나 지금 버전 지킴이에서 띄운다 |
| OSC 훑는 비용 | 2MB 를 정규식으로 0.2ms. 실제로는 headless 의 `parser.registerOscHandler` 로 받는다(조각 경계도 맞음) |

→ 전제는 유지. **바뀐 것: headless scrollback 을 2000줄 상한**(100 pane ≈ 450MB). 보드의 '조용한 셸부터 줄 수 줄이기' 대신 고정 상한.

## 설계

### 구조
| 조각 | 위치 | 하는 일 |
|---|---|---|
| 프로토콜(순수) | `src/shared/ptyhost.ts` | 버전 `PTYHOST_PROTOCOL=1` · 줄 단위 JSON 프레임(`LineDecoder` — 조각 · 한글 경계) · 요청 검사 · 소켓 경로 · 다시 연결 간격 `[1,2,4,8,16]초` · 주인 없는 셸 고르기 · 메모리 경고 판정 · 다시 붙을 때 되돌려 줄 OSC 고르기 |
| 지킴이 핵심 | `src/main/ptyhost/host-core.ts` | 세션(pty + headless Terminal(scrollback 2000) + OSC 기록) · 요청 처리. pty 만드는 함수를 주입받아 vitest 로 시험 |
| 지킴이 입구 | `src/main/ptyhost/host-entry.ts` → `out/main/host.js` (electron-vite main 둘째 입력) | 소켓 서버(umask 077 · 0600) · node-pty · 로그 `<userData>/ptyhost.log`(1MB 넘으면 비움). **electron 을 import 하지 않는다**(node 모드라 없음) — 단위 시험이 소스를 읽어 막는다 |
| 지킴이 손님 | `src/main/ptyhost/client.ts` | 연결 · hello · 요청 id · 끊기면 다시 연결 · 지킴이 띄우기 |
| PtyManager | `src/main/pty-manager.ts` | 지금 API 를 그대로 두고 속을 지킴이로. owner(WebContents) 와 pid 는 main 이 들고, 출력은 OutputBatcher 로 renderer 에 |

소켓: `<userData>/ptyhost-v1.sock`(보드는 `ptyhost.sock` — 버전마다 다른 이름으로 바꿈, 옛 버전 지킴이를 찾으려고). 경로가 100바이트를 넘으면(맥 소켓 경로 한도 104) `os.tmpdir()/taskminal-<userData 해시 12자>-v1.sock`.
지킴이 프로세스: `process.execPath` + `ELECTRON_RUN_AS_NODE=1`, detached · stdio 무시 · cwd `/`, 인자 `host.js <소켓> <userData>`. 이미 떠 있으면(소켓에 연결됨) 새로 띄우지 않는다. 떠 있는 지킴이가 소켓에 붙지 못하면 스스로 끝낸다.

### 프로토콜 (줄마다 JSON, v1)
손님 → 지킴이: `hello{version}` · `spawn{paneId,file,args,cwd,env,cols,rows}` · `attach{paneId}` · `detach{paneId}` · `write` · `resize` · `kill{paneId}`(SIGHUP, 2초 뒤 SIGKILL) · `list` · `tail{paneId,lines}` · `stats` · `shutdown`(모두 끝내고 지킴이도 끝남). 답은 `{id, ok, …}`.
지킴이 → 손님: `data{paneId,data}` · `exit{paneId,exitCode,signal}`.
- spawn 에 같은 paneId 가 살아 있으면 새로 만들지 않고 `existing:true`(지금 PtyManager 규칙 그대로).
- attach: `{found, pid, screen(serialize — 대체 화면 · 모드 포함), replay(명령 상태 OSC), detachedMs, exited?}` 를 답하고 그 뒤 출력은 이 손님에게. 답과 출력이 한 소켓이라 순서가 맞는다.
- 셸이 손님 없이 끝나면 화면과 끝난 이유를 남겨 두었다가 다음 attach 에서 준다(손님도 셸도 없이 60초면 지킴이가 끝나며 버림).
- 지킴이 끝남: 살아 있는 셸 0 · 손님 0 이 60초 · `shutdown` · userData 폴더가 사라짐(2초마다 확인 — e2e 정리 · 앱 지우기).

### renderer 흐름 (TerminalPane)
마운트 → `pty.attach(paneId)` →
- 붙음: main 이 `\x1bc`(지움) + screen + replay 를 ptyData 로 먼저 보낸 뒤 답 → 파일 되살리기 · 시작 명령 안 함 · 지금 크기로 resize.
- 없음: 지금처럼 스크롤 되살리기(13단계) → spawn.
시작 명령은 attach 답을 받기 전에는 보내지 않는다(되돌린 OSC 133;A 가 sendStart 를 부르지 않게).

### 종료 경로 (규칙 electron-architecture)
| 경로 | 셸 | 상태 · 스크롤 |
|---|---|---|
| 창 닫기 · 새로 고침 · 렌더러 충돌 | **detach 만**(지킴이에 남음). 렌더러 충돌은 창을 다시 읽어 다시 붙는다 | 지금 그대로(beforeunload · 30초 저장) |
| ⌘Q (role quit) | 묻지 않고 detach. **처음 한 번만** 안내(셸이 있을 때): '이제 앱을 꺼도 셸은 계속 돌아요' [앱만 끄기 ↩][셸까지 모두 끝내기][취소] — 본 표시는 `<userData>/quit-notice-seen` | will-quit flush |
| ⌥⌘Q '셸까지 모두 끝내기…' (메뉴 · ⌘P) | 실행 중 명령이 있고 '끄기 전에 묻기'(11단계 설정)가 켜져 있으면 '실행 중인 명령 n개를 끝낼까요?' [닫기 ↩(기본 · Esc)][모두 끝내기] → `shutdown` 답을 받은 뒤 끝냄 | 같음 |
| 일감 · 탭 · pane 지우기 | kill(지금처럼) | — |
| 지킴이가 죽음(충돌 · kill) | 새 지킴이를 띄우고 창을 다시 읽는다 → attach 없음 → 13단계 되살리기 | beforeunload 저장이 돈 뒤 다시 읽음 |
| 재부팅 | 지킴이 없음 → 13단계 되살리기 + 안내 '셸을 새로 띄웠어요 — 폴더와 이전 출력은 되살렸지만 돌던 명령은 끝났어요' | — |
지금의 '창 닫기 전 확인' · '⌘Q 전 확인'은 없앤다(셸이 끝나지 않으므로) — 확인은 ⌥⌘Q 로 옮김(보드 결정).

### 연결 · 버전
- 연결이 끊기면(지킴이는 살아 있음) 1·2·4·8·16초 다섯 번 다시 붙는다. 그 동안 입력은 main 이 버리고 renderer 는 빨간 줄 '셸 지킴이와 연결이 끊겼어요 · 다시 연결 중 2/5'. 붙으면 모든 pane 을 다시 attach(지움 + 화면). 다섯 번 실패면 '셸 지킴이에 연결하지 못했어요' [다시 연결][지킴이 다시 시작…][오류 기록 보기].
- 끊긴 뒤 지킴이 프로세스가 없으면(pid 확인) 기다리지 않고 새로 띄워 창을 다시 읽는다(위 표).
- 시작할 때 userData 의 다른 버전 소켓(`ptyhost-v*.sock`)에 hello → 살아 있는 셸이 있으면 노란 줄 '새 버전과 맞지 않는 지킴이예요 — 셸 n개가 끝나면 저절로 사라져요' [나중에][지금 바꾸기…(확인 뒤 shutdown)].

### 꺼져 있던 동안 · 화면에 올리기
- 지킴이가 OSC 133(A·C·D) · 6973(명령) · 9 · 777 · 벨을 headless 파서로 받아 세션마다 '손님이 본 뒤 생긴 것'을 기록(최근 32개).
- `list` 가 세션마다 `unseen: {waiting, failed, message}` · `lastOutputAt` · `detachedMs` 를 준다. 앱이 처음 읽힐 때 renderer 가 한 번 불러, 상태에 있는 pane 이면 활동 사건(notify · end)으로 넣는다 → 사이드바 확인 필요(노랑) · 배지 그대로. 아직 마운트되지 않은 탭의 pane 도 된다.
- 위 줄(배너): 붙은 셸이 있으면 '셸 n개가 그대로 이어졌어요 — 꺼져 있던 X 동안의 출력도 받아 왔어요' [닫기]. 기다리는 셸이 있으면 '꺼져 있던 동안 n개가 입력을 기다려요 — <일감 › 탭 · 메시지>' [보러 가기 ⇧⌘A][다음에].
- attach 의 replay 는 명령 상태(마지막 6973 · 133 C/D)만 — 알림은 list 로 한 번만.

### 설정 › 셸 지킴이 (새 칸) · ⌘P
- 상태 '● 실행 중 · 3일 4시간' / 버전 / 셸 n개 · 메모리 / 앱을 끝낼 때 '⌘Q 앱만 · ⌥⌘Q 셸까지 모두' / 소켓 위치 · 프로세스 번호.
- 주인 없는 셸(상태에 없는 paneId): 회색 줄 '<paneId> · <명령> · 주인 없음 · n일째' [마지막 출력 보기(20줄)][끝내기(확인)] + [모두 끝내기 (n)]. 자동으로 끝내지 않는다.
- [지킴이 다시 시작…] 확인('지금 실행 중인 명령 n개가 끝나요. 폴더와 출력만 되살아나요') → shutdown · 새 지킴이 · 창 다시 읽기.
- 메모리: main 이 5분마다(시작 10초 뒤 처음) `stats` → 1GB 이상 또는 셸 100개 이상이면 실행마다 한 번 노란 줄 '셸 지킴이가 메모리 1.1GB 를 쓰고 있어요 — 주인 없는 셸 n개 · 오래 조용한 셸 m개' [목록 보고 끄기 ↩(설정 칸 열기)][다음에].
- ⌘P 명령: '셸 지킴이 보기'(설정 칸) · '주인 없는 셸 정리'(설정 칸) · '셸까지 모두 끝내기'(⌥⌘Q). 단축키 표(keymap)에 넣는다 — quit-all 은 ⌥⌘Q, 둘은 키 없음.
- 메뉴: 'Taskminal 끝내기 (셸은 계속 돌아요) ⌘Q' · '셸까지 모두 끝내기… ⌥⌘Q'.

### 지키는 것
- 소켓 0600 + umask 077, 지킴이는 같은 사용자만. 요청 검사는 지킴이도 한다(paneId · 크기 · 입력 상한 1MB · 파일은 절대 경로) — main 이 이미 검사하지만 소켓은 다른 프로세스도 열 수 있다(같은 사용자).
- 셸 환경은 main 이 지금처럼 만든다(shellEnv · integrationEnv · pickShell) — 지킴이 자체 환경을 셸에 넘기지 않는다.

plan-check: 서버 없음 — 로컬 프로세스 · 유닉스 소켓만 쓰는 데스크톱 앱 단계
- 결과를 모를 때: 지킴이 요청에 5초 안에 답이 없으면 실패로 보고 renderer 에 오류(spawn 이면 '셸을 띄우지 못했습니다'). 그 사이 지킴이가 실제로 셸을 만들었으면 다음 attach · list 에서 보인다(같은 paneId 는 새로 만들지 않으므로 둘이 되지 않음).
- 다시 시도: 연결 끊김은 1·2·4·8·16초로 다시 붙고 붙으면 모든 pane 을 다시 attach 해 화면부터 이어 간다. 다섯 번 실패 뒤는 사용자가 [다시 연결] 로 다시 시도.
- 이중 입력: ⌥⌘Q · [지킴이 다시 시작…] 을 실행 중에 다시 누르면 무시(진행 중 표시). 확인 창이 떠 있으면 두 번째 창을 띄우지 않는다(지금 asking 규칙).
- 취소 · 닫기: 확인 창의 기본 · Esc 는 '닫기'(아무것도 끝내지 않음). 처음 ⌘Q 안내의 취소는 앱을 끄지 않는다.

## 시험
단위(vitest):
- `tests/unit/ptyhost.test.ts`: LineDecoder(조각 · 한 줄 여러 프레임 · 한글 바이트 경계 · 상한 넘는 줄 버림) · 요청 검사(나쁜 paneId · 크기 · 큰 입력 · 상대 경로) · 소켓 경로(길면 tmpdir 해시) · 다시 연결 간격 · 주인 없는 셸 · 메모리 경고 · replay 고르기.
- `tests/unit/ptyhost-core.test.ts`(가짜 pty + 실제 headless): spawn → 출력 → detach → 출력 → attach 의 screen 에 둘 다 · 같은 paneId spawn 은 기존 · kill · 손님 없이 끝난 셸의 exit 를 attach 가 줌 · unseen(벨 · 9 · D;1) 이 list 에 · attach 뒤 unseen 비움 · 유휴 끝냄 판정 · shutdown.
- `tests/unit/ptyhost-entry.test.ts`: host-entry · host-core 소스가 electron 을 import 하지 않음.
e2e(`tests/e2e/persist.spec.ts`, 새로):
1. `sleep 600 & echo $$ $!` → 앱 끝냄 → 두 pid 살아 있음 → 다시 띄움 → 같은 `$$` · 이전 출력이 보이고 '셸 n개가 그대로 이어졌어요' 줄 · 새 명령이 같은 셸에서 돎.
2. ⌥⌘Q(메뉴 항목 click) + 실행 중 명령 + 확인 → 대화상자 답 '모두 끝내기' → 셸 · 자식 · 지킴이 pid 모두 없음. 답 '닫기' 면 아무것도 안 끝남.
3. 지킴이 `kill -9` → 창이 다시 읽히고 '── 이전 세션' (13단계 복원) · 새 셸이 응답.
4. 주인 없는 셸: 출력 남김 → 앱 끝냄 → state.json 에서 그 pane 을 뺀 뒤 다시 띄움 → 설정 › 셸 지킴이에 그 셸 · 마지막 출력 보기에 글 · 끝내기 → 셸 pid 없음.
5. 꺼져 있던 동안의 입력 기다림: `(sleep 2; printf '\e]9;확인해 주세요\a') &` → 앱 끝냄 → 3초 뒤 다시 띄움 → 사이드바 확인 필요 · 배너 '입력을 기다려요'.
6. 처음 ⌘Q 안내: 본 표시 없이 → `app.quit` 경로(메뉴 role 대신 before-quit) 에서 대화상자 한 번, 두 번째는 없음.
7. 다른 버전 지킴이: `TASKMINAL_PTYHOST_PROTOCOL=0` 으로 띄워 셸 → 끝냄 → 보통으로 다시 띄움 → '맞지 않는 지킴이' 줄 → 지금 바꾸기 → 옛 셸 pid 없음.
8. 연결 못 함: `TASKMINAL_PTYHOST_SCRIPT=<없는 파일>` + `TASKMINAL_PTYHOST_RETRY_MS=50` → '셸 지킴이에 연결하지 못했어요' 줄.
9. 메모리 경고: `TASKMINAL_PTYHOST_WARN_MB=1` + `TASKMINAL_PTYHOST_STATS_MS=500` → 노란 줄 → [목록 보고 끄기] 가 설정 칸을 연다.
10. ⌘P '셸 지킴이 보기' → 설정 › 셸 지킴이.
기존 e2e 바꿈: terminal.spec 종료 경로 ①~④ · SIGHUP 무시 2개 · 다시 띄우면 곧바로 응답 → '셸이 남는다 / 다시 붙는다' 로 뜻을 바꿈(①②③④) · ⌥⌘Q 로 끝내는 쪽은 persist.spec. restore.spec 은 다시 띄우기 전에 지킴이를 끝내(13단계 대비 길을 시험) 기존 기대를 유지. settings.spec '끄기 전 확인' 은 ⌥⌘Q 로. playwright 설정에 `TASKMINAL_QUIT_NOTICE=seen`(처음 ⌘Q 안내가 시험 정리를 막지 않게 — 그 안내를 보는 시험만 지움).

## 순서 → verify
1. 스파이크(위, 끝) → 이 계획 + plan-check
2. `npm i @xterm/headless@6.0.0` · 단위 시험(빨강) → shared/ptyhost.ts → host-core → 초록
3. host-entry · client · PtyManager 교체 · electron-vite 둘째 입력 → 기존 e2e(terminal.spec)로 셸이 뜨는지
4. 종료 경로 · ⌘Q/⌥⌘Q · 메뉴 · keymap → e2e 1 · 2 · 6
5. 지킴이 죽음 · 연결 끊김 · 버전 → e2e 3 · 7 · 8
6. renderer: 배너 · 설정 칸 · 주인 없는 셸 · 메모리 · ⌘P → e2e 4 · 5 · 9 · 10 · 스크린샷 확인
7. 패키지: `npm run package` → .app 을 임시 데이터 폴더로 띄워 셸이 지킴이에서 뜨는지(host.js 가 asar 안에서 돔) · check-package 에 host.js 확인 추가
8. 변이(핵심 줄) → full-check → 커밋 → 리뷰 → 문서 → main ff → 회고

## 하지 않는 것 (보드)
재부팅 뒤 셸 살리기 · 다른 기기에서 붙기 · tmux/screen 연동 · 로그인 때 자동 시작 · launchd 에이전트.
이번에 미룸(계획과 다르게 — 보고에 적음): 옛 버전 지킴이에 계속 붙어 쓰기('기다리기' — 프로토콜 v1 뿐이라 아직 옛 버전이 없음, 감지 · 바꾸기만) · 조용한 셸부터 headless 줄 수 줄이기(고정 2000 상한) · 터미널 안 '── 앱이 꺼져 있던 동안 ──' 구분 줄(TUI 화면에 끼우면 깨짐) · 다시 붙은 명령의 경과 시간은 다시 붙은 때부터 · 주인 없는 셸 목록의 ↑↓ 이동(단추 Tab 순서로).

## 결과
- 시험: 단위 383(파일 33 — 새로 ptyhost · ptyhost-core · ptyhost-entry · pty-manager · ptyhost-client) · e2e 123(새로 persist.spec 9). 구현 커밋 전체 검사 종료 0, 리뷰 고침 뒤 종료 3(links.spec 'OSC 8 링크' 가 한 번 '보이지 않음' 으로 실패 → 다시 돌려 통과 — 이번 변경과 무관해 보이나 원인 미확인).
- 리뷰(/code-review medium) 10건 중 고친 것 8: attach · spawn 답과 한 덩어리로 온 출력 · exit 를 버림 · 처음 연결 실패 뒤 [다시 연결] 이 창을 다시 읽지 않음 · 끊긴 동안 연 pane 이 셸을 잃음(둘 다 '놓친 pane 이 있으면 다시 붙을 때 창을 다시 읽기' 로) · 기다리는 사이 떠난 창을 주인으로 잡음 · hello 전 끊김에 다시 붙기 고리 둘 · ⌘Q 안내의 셸 수가 5분 묵은 값 · 더 새 지킴이를 옛 버전으로 봄 · 끝난 셸 기록이 있는데 유휴로 끝남. 시험 pty-manager 6 · client 1 은 옛 코드에서 실패 확인.
- 고치지 않은 것: 끝난 셸의 headless 를 attach · tail 콜백 전에 닫는 문제 — 시험을 만들어 보니 옛 코드에서도 화면이 온다(재현 안 됨, 시험만 남김) · tailText 가 버퍼 전체를 훑음(클릭 한 번 2000줄, 무시할 만함) · envInt 두 벌(시험용 환경 변수만 읽음).
- host-control 의 연결 순서(다시 붙을 때 창 다시 읽기) · ⌘Q 셸 수 · 버전 비교는 단위 시험 없이 e2e(6 · 7)와 코드로만 확인.
- 변이 12개(핵심 줄): 처음 9개 중 6 잡힘 · 2 못 잡음 · 1 판정 불가 → 시험 1개 더함(성공 `D;0` 을 실패로 세는 변이) · 쓸모없는 가드 1줄 지움(SIGKILL 타이머 안의 exited 검사 — 같은 뜻 변이) · 디코더 상한 변이는 좁혀 다시 → 3/3 잡힘. 최종 12/12.
- 패키지: `npm run package` → `dist/mac-arm64/Taskminal.app` 을 임시 데이터 폴더로 띄워 지킴이가 `Resources/app.asar/out/main/host.js` 에서 돎 · 다시 띄우면 같은 셸에 붙고 '셸 1개가 그대로 이어졌어요' · ⌥⌘Q 뒤 지킴이 없음.
- 전체 검사 첫 회에 keys.spec '앱 메뉴' 가 실패 — 키 없는 ⌘P 전용 명령(host-view · host-orphans)도 메뉴에 있기를 기대 → 시험을 '키 있는 명령' 으로 좁힘.
- persist e2e 1번이 개발 중 한 번 실패(끈 뒤 셸 프로세스가 없음) — 원인 미확인, 그 뒤 전체 실행 3번 모두 통과.

계획과 다르게 한 것
- e2e 10(⌘P '셸 지킴이 보기')은 따로 두지 않고 4번(주인 없는 셸)이 ⌘P '셸 지킴이 보기' 로 설정 칸을 여는 것으로 합침. '주인 없는 셸 정리' 명령은 같은 칸을 여는 같은 길이라 따로 e2e 없음.
- e2e 3 은 계획대로 '── 이전 세션' 을 보지만, restore.spec 의 '새로 고침' 시험은 이제 이어 붙음(이전 세션 줄 없음)으로 기대를 바꿈 — 새로 고침은 셸을 끝내지 않으므로.
- 처음 ⌘Q 안내 · ⌥⌘Q 확인은 보드의 앱 안 배너가 아니라 macOS 대화상자(design-gaps 16단계 표).
- '이번에 미룸' 5개(위 '하지 않는 것').
- main 쪽은 처음에 e2e 로만 확인했다가 리뷰 뒤 pty-manager · client 단위 시험을 더함. host-control 은 여전히 e2e 만.
