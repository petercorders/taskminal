# Taskminal 13단계 — 재시작 복원

## Context
docs/plan.md 13단계: 작업 폴더 추적(OSC 7 또는 lsof) · 스크롤 내용 저장(SerializeAddon, pane 당 상한) · 종료 시 flush · 주기 저장 · 복원 시 명령 재실행 안 함 + 11단계에서 미룬 '스크롤 되살리기' 설정.
verify: e2e 로 `cd /tmp` 후 앱 재시작 → 같은 폴더 · 이전 출력 보임 · 시작 명령 재실행 없음.
지금: 일감 · 탭 · 분할 · pane.cwd(만든 때의 폴더)는 state.json 으로 되살아난다. 셸 안의 cd 는 저장되지 않고, 화면 내용은 사라진다. 시작 명령 재실행 없음은 12단계에서 끝(pendingCommand 지움).
사용자 지시: 15단계까지 묻지 않고 진행 → 선택은 추천안으로 정해 여기 적는다.

## 설계

### 작업 폴더
| 길 | 내용 |
|---|---|
| OSC 7 (셸 통합) | `resources/shell/zsh/taskminal-hooks.zsh` precmd 에서 `\e]7;file://$HOST<퍼센트 인코딩한 $PWD>\a`. renderer `parseOsc7(data, localHost)` (src/shared/cwd.ts, 순수) → 경로 또는 null. **다른 호스트(ssh 안의 셸이 보낸 OSC 7)는 버린다** — 호스트가 비었거나 localhost 거나 이 Mac 이름(appInfo.host, 대소문자 · `.local` 무시)일 때만 |
| lsof (통합 없음 · bash 등) | main `PtyManager.cwds(owner)` = `lsof -a -d cwd -Fpn -p <셸 pid들>` 한 번(execFile, 2초 제한) → `parseLsofCwd`(순수) → { paneId: 폴더 }. renderer 가 15초마다, OSC 7 을 한 번도 보내지 않은 pane 만 묻는다. 최대 15초 늦음(그 사이 끄면 마지막 cd 를 놓친다 — 남은 것으로 적음) |
| 반영 | `pane/cwd {paneId, cwd}` → 같으면 상태 그대로(저장 안 함). 탭 이름(tabLabel)이 cd 를 따라간다(6단계에서 미룬 것) |
| **함정** | TerminalPane effect 의존성이 `[paneId, cwd]` → cwd 가 바뀌면 xterm · 구독이 통째로 다시 만들어진다. cwd 는 ref 로 띄울 때만 쓴다 |
| 없는 폴더 | 복원 때 폴더가 지워졌으면 지금처럼 resolveCwd 가 홈으로(기존 동작 확인 시험) |

### 스크롤 내용
| 항목 | 결정 |
|---|---|
| 저장 위치 | `<userData>/scrollback/<paneId>.txt` (state.json 과 분리 — 상태 저장마다 MB 를 쓰지 않게). 원자적 쓰기(tmp → rename) · 파일 0600 · 폴더 0700(**터미널 출력에 비밀값이 있을 수 있다** — 설정 설명에 '디스크에 저장' 을 적고, 끄면 모두 지운다) |
| 만들기 | `@xterm/addon-serialize`(이미 설치) `serialize({ scrollback: min(설정, 5000), excludeAltBuffer: true, excludeModes: true })` — vim · Claude 같은 전체 화면 프로그램 화면은 빼고, 커서 숨김 같은 모드도 남기지 않음. main 은 pane 당 2MB 넘으면 버린다(renderer 를 믿지 않음) · paneId 는 isPaneId 로 검사(경로 조작 차단) |
| 언제 | ① 페이지가 내려갈 때(`beforeunload` → `sendSync`): 앱 종료 · 창 닫기 · 새로 고침 3경로 ② 30초마다 바뀐 pane 만(출력이 온 pane = dirty): 렌더러 충돌 · 강제 종료 대비 ③ 렌더러 충돌은 ② 의 마지막 것까지 |
| 무엇을 같이 보내나 | `{ live: 상태에 있는 모든 paneId, panes: { paneId: 글 } }` — main 이 live 에 없는 파일을 지운다(닫은 pane · 지운 일감). 아직 한 번도 보지 않은 탭의 pane 은 live 에 있으니 파일이 남는다 |
| 되살리기 | TerminalPane 이 셸을 띄우기 전에 `scrollback.load(paneId)` → 있으면 쓰고 흐린 줄 `── 이전 세션 · 11-10 20:31 ──`(파일 시각) 뒤에 셸. 앱 실행마다 pane 당 한 번(모듈 Set — 다시 마운트돼도 두 번 쓰지 않음). 되살린 글에는 OSC 가 없어 시작 명령 · 활동 신호가 돌지 않는다 |
| 설정 | 터미널 칸 `restoreScrollback`(기본 켬) '스크롤 되살리기 — 다시 열 때 이전 출력을 보여 줘요(디스크에 저장)'. 끄면 다음 저장에서 live=[] 로 모두 지우고, 읽지도 않는다. 설정 정규화에 새 칸(옛 파일은 기본값, 11단계 '원본 값이 남았나' 판정에 걸리지 않는지 시험) |

### 종료 경로 4개 (규칙: electron-architecture)
| 경로 | 셸 | 상태 | 스크롤 |
|---|---|---|---|
| 앱 종료(⌘Q) | will-quit killAll(그대로) | will-quit flush(그대로) | 창이 닫히며 beforeunload → sendSync (main 이 동기로 씀) |
| 창 닫기 | destroyed → killOwner | 디바운스 타이머 | beforeunload |
| 새로 고침 | did-start-navigation | stateLoad 가 flush | beforeunload → 새 페이지가 되살림 |
| 렌더러 충돌 | render-process-gone | 받은 것까지 | 마지막 30초 저장까지(남은 것) |
| 끄기 전 확인으로 취소 | 그대로 | — | beforeunload 가 안 돈다(창이 안 닫힘) — 저장 안 함, 맞다 |

plan-check: 서버 없음 — 로컬 파일 · 로컬 프로세스만 쓰는 데스크톱 앱 단계
- 결과를 모를 때: 저장 실패(디스크 가득 · 권한)는 main 이 console 로 남기고 앱은 계속(스크롤은 덤 — 상태 저장처럼 알림 띄우지 않음). 읽기 실패 · 깨진 파일은 되살리지 않고 셸만 띄운다.
- 다시 시도: 30초 주기가 다음에 다시 쓴다.
- 이중 입력: 같은 pane 을 두 번 되살리지 않게 Set · sendSync 는 한 번(beforeunload 는 페이지당 한 번).
- 취소 · 뒤로: 끄기 확인 취소면 아무것도 저장하지 않음(위 표).

## 시험
단위
- `tests/unit/cwd.test.ts`: parseOsc7(인코딩된 한글 · 공백 · 다른 호스트 거름 · localhost · 빈 호스트 · .local · 잘못된 글) · parseLsofCwd(여러 pid · n 줄 없는 pid · 이상한 줄)
- 모델: `setPaneCwd` 같은 값이면 같은 객체 · 없는 pane 그대로 · tabLabel 이 따라감
- 설정: restoreScrollback 정규화 · 옛 파일(칸 없음)이 손실로 판정되지 않음
- main 통합(node): `ScrollbackStore`(src/main/scrollback-store.ts) — 쓰기 · 읽기 · live 밖 지우기 · 2MB 넘음 버림 · 이상한 paneId(`../x`) 거절 · 파일 권한 0600 — 실제 임시 폴더로
e2e `tests/e2e/restore.spec.ts`
1. `cd /tmp/...한글 폴더` + `echo 표식` → 앱 재시작 → 같은 pane 의 `pwd` 가 그 폴더 · 이전 표식 보임 · '이전 세션' 줄 · 탭 이름이 폴더 이름 · 스크린샷
2. 셸 통합 끔 → cd → 15초 주기(시험에서는 짧게: `TASKMINAL_CWD_POLL_MS` 환경 변수 — main 이 renderer 에 appInfo 로 줌) 뒤 재시작 → 같은 폴더(lsof 길)
3. 새로 고침(window reload)도 이전 출력 보임 · 같은 화면에 두 번 되살아나지 않음(표식이 한 번)
4. 설정에서 끄면 → 재시작해도 이전 출력 없음 · scrollback 폴더 비어 있음
5. 탭 닫기 → 재시작 뒤 그 pane 파일이 없음(live 정리) · 아직 안 본 탭의 파일은 남아 있다가 그 탭을 열면 되살아남
6. 템플릿 일감: 시작 명령 출력이 되살아나도 명령은 다시 안 돎(12단계 시험이 이미 봄 — 되살린 화면에서도 마커 파일 줄 수 그대로)
7. 전체 화면 프로그램(less) 띄운 채 재시작 → 되살린 화면이 일반 화면(less 화면 아님)

## 순서 → verify
1. shared cwd · lsof 파서 · 모델 · 설정 → vitest
2. main ScrollbackStore · IPC(load invoke · saveSync on · cwds invoke) · preload · api.d.ts → 통합 시험 · typecheck · 경계
3. zsh OSC 7 → e2e 1
4. TerminalPane(cwd ref · 되살리기 · serialize 등록) · App(주기 저장 · beforeunload · lsof 주기 · pane/cwd) · 설정 칸 → e2e 전부 · 스크린샷 직접 확인
5. 변이(핵심 줄, 시작 전 건수 · 예상 알림) → full-check.sh → 커밋 → /code-review → 수정 커밋 → main ff → 회고(gc 반영까지) → 바로 14단계

## 하지 않는 것
- 실행 중이던 명령 다시 돌리기(일부러 안 함) · 다른 호스트(ssh) 폴더 추적 · bash/fish 용 OSC 7 통합(lsof 로 대신) · 스크롤 저장 암호화(파일 권한 0600 + 끄기)
