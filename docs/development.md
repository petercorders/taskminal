# Taskminal 개발 진행 문서

이 문서만 읽고 다음 단계를 이어 갈 수 있게 쓴다. 단계의 범위 · verify 는 `docs/plan.md`, 단계별 상세 계획은 `docs/stages/`.
마지막 갱신: 2026-11-11 (19단계 기록과 찾기 병합 — 단위 615 · e2e 144 + 패키지 1, 다음은 20단계. 서명 · 공증은 사용자 준비물 뒤 `npm run release`)

## 1. 지금 어디까지

| 단계 | 상태 |
|---|---|
| 0~12 | 끝, `main` 에 병합 (12단계 = main `3d570ab`) |
| 13 재시작 복원 | **단위까지 확인 · e2e 미실행** — main 에 병합. 브랜치 이름은 `stage-13`(worktree `~/taskminal-work`, ~/taskminal 의 `stage-13-restore` 는 그 앞 문서 브랜치). e2e 는 사용자 지시(2026-11-10 "지금 실제 테스트는 하지마")로 돌리지 않음 — 돌려야 할 목록은 `docs/stages/13-restore.md` 결과 절 |
| 14 패키징 · 설치 | main 에 병합(브랜치 `stage-14-package`). `npm run package` 로 `dist/mac-arm64/Taskminal.app` + 정적 검사. 2026-11-11 임시 데이터 폴더로 .app 실행 확인(셸 · 한글 · 최소 환경 `which node` · 아이콘 · 패키지 node-pty) — Finder 더블클릭 · /Applications 설치는 사용자 확인 대상. `docs/stages/14-package.md` 결과 절 '실행 확인' |
| 15 다듬기 | **단위까지 확인 · e2e 미실행** — main 에 병합(브랜치 `stage-15-polish`). 15a~15f 항목별 문서(`docs/stages/15a-notify.md` ~ `15f-worktree.md`) 결과 절에 돌려야 할 e2e. playwright 설정이 기본 `TASKMINAL_RENDERER=dom`(15e) — 기존 e2e 전체도 다시 |
| 13~15 e2e | 2026-11-11 브랜치 `stage-15-e2e-fix`(e2e 고침 3커밋) 로 전체 검사 통과(e2e 115개) → main ff 병합 `73c70cd` |
| 16 셸 지킴이 | main 에 병합(브랜치 `stage-16-persist`). 단위 383 · e2e 123 통과 · .app 에서 지킴이 확인. 계획 · 결과 `docs/stages/16-persist.md` |
| 17 데이터 안전 | main 에 병합(브랜치 `stage-17-safety`). 백업 · 되돌리기 · 손상 복구 · 내보내기/가져오기 · `redact()` · 화면 가림. 계획 · 결과 `docs/stages/17-safety.md` |
| 18 출시 기본기 | main 에 병합(브랜치 `stage-18-release`). 자동 업데이트(GitHub Releases) · 오류 기록 · 지난번 꺼짐 · 첫 실행 안내 · `npm run release`(서명 · 공증 — Developer ID 인증서 · 공증 프로필 `taskminal-notary` 를 사용자가 만든 뒤). 계획 · 결과 `docs/stages/18-release.md` |
| 19 기록과 찾기 | main 에 병합(브랜치 `stage-19-history`). 명령 기록 ⌘Y(`<userData>/history/*.jsonl`, 가린 뒤) · 모든 출력 찾기 ⇧⌘F · ⌘P 기록 · 설정 › 개인정보 모두 지우기. 계획 · 결과 `docs/stages/19-history.md` |
| 20~25 1차 출시 | 20 부터 — `docs/plan.md` "1차 출시까지" 표 · 보드는 디자인 캔버스 1차 출시 구역(2026-11-11 추천안 채택) |
| (단계 아님) 디자인 맞추기 | `docs/design-gaps.md` — **사용자가 고치는 문서**. 15단계가 끝난 뒤 사용자와 함께 단계로 나눈다. 그 전에는 사용자가 쓴 내용을 고치지 말고, 단계 작업 중 디자인과 다른 점을 새로 찾으면 항목만 더한다 |

단계를 끝낼 때마다 이 표와 '마지막 갱신' 줄을 고친다.

## 2. 진행 방식 (사용자 지시)

- **15단계까지 묻지 말고 이어서 진행한다.** 디자인 맞추기는 15단계 뒤 사용자와 단계로 만든 다음에. 선택은 추천안으로 정해 계획에 적는다. 단계 사이에 멈추지 않고, 보고는 끝에 한 번.
- 예외 — 반드시 사용자 확인: GitHub 원격 만들기 · push(원격 없음) · `/Applications` 에 실제 설치(14단계) · 사용자 Claude Code 설정 바꾸기 · 실제 데이터 폴더(`~/Library/Application Support/Taskminal`) 건드리기.
- 보고 · 커밋 메시지는 한국어.

## 3. 단계 하나의 순서

1. `git checkout -b stage-N-<이름> main` (진행 중인 브랜치가 있으면 그것)
2. 계획을 `docs/stages/N-<이름>.md` 에 쓴다 — 라이브러리 동작에 기대는 줄(세는 상한 · dispose 가 무엇을 놓는지 등)은 `node_modules` 소스의 파일 · 줄을 읽고 적는다(15d · 15e 에서 addon 동작을 가정했다가 리뷰가 짚음) — 범위 · 설계 표 · 시험 · `순서 → verify` · 하지 않는 것. 앱 종료 4경로(앱 종료 · 창 닫기 · 새로 고침 · 렌더러 충돌)에서 셸 · 저장이 어떻게 되는지, 열린 대화상자 · 비동기 then 의 대상이 그 사이 사라지면 어떻게 되는지 칸을 둔다. 디자인이 있는 화면이면 **디자인 요소를 할 일 칸에 옮겨 적는다**(빠뜨려서 `docs/design-gaps.md` 가 생겼다).
   점검: `bash ~/.claude/skills/harness-run/scripts/plan-check.sh docs/stages/N-….md` (서버 없는 단계는 계획에 `plan-check: 서버 없음 — <이유>` 한 줄)
3. 시험 먼저(빨강) → 구현 → 통과. 편집마다 훅이 경계 · tsc · 관련 vitest 를 돌린다 — 실패 메시지를 읽고 고친다.
4. 변이 확인 — 새 시험이 핵심 줄을 실제로 잡는지. 시작 전에 "변이 N개 · 예상 M분" 을 말한다.
   목록 파일(탭 구분 `파일⇥원문⇥바꿀 글⇥라벨⇥시험 명령`) → `bash ~/.claude/skills/harness-engineering/stacks/common/scripts/mutation-check.sh --check <목록>` 로 먼저 점검 → `… --batch <목록> npx vitest run`
   e2e 변이의 5번째 칸: `sh -c 'npm run build >/dev/null && npx playwright test tests/e2e/x.spec.ts -g <이름> --reporter=line'`
5. 전체 검사: `bash ~/.claude/skills/harness-engineering/stacks/electron/scripts/full-check.sh` — 종료 코드 0 통과 · 1 실패 · 3 불안정(실패한 e2e 를 다시 돌려 통과). 사용자가 앱 실행을 막았으면 `FULL_CHECK_NO_E2E=1` → 종료 코드 4(e2e 미실행) — '통과' 로 쓰지 않는다. `| tail` 로 감싸지 않는다(종료 코드가 사라진다). 화면이 바뀐 단계는 `test-results/*.png` 스크린샷을 직접 열어 본다.
6. 커밋 전에 단계 문서의 코드 칸(경로 · IPC 채널 이름)을 코드와 대조: `python3 ~/.claude/skills/harness-engineering/stacks/common/scripts/doc-refs-check.py docs/stages/N-….md .` — 종료 코드 1 이면 문서나 코드를 고친다(15b 에서 문서 `app:openLink` ≠ 코드로 리뷰가 짚음, 옛 이름을 일부러 적은 줄은 `<!-- refs-ignore -->`). 그다음 커밋 → `/code-review medium main...stage-N-…` → 고친 것은 **별도 커밋** → 다시 전체 검사
7. `docs/plan.md` 그 단계 줄에 `(완료: …)` · 이 문서 1절 갱신 → 커밋 → `git checkout main && git merge --ff-only stage-N-…`
8. 회고 `/harness-gc electron retro` — retro-collect 출력 끝의 gc 진단(승격 후보 · 승격 후 재발 · 규칙 감사)까지. 도구화 후보는 보고로 끝내지 말고 반영해 실제 입력으로 확인한다.
9. 메모리 `~/.claude/projects/-Users-gimgibong/memory/project_taskminal.md` 에 단계 한 줄 · `MEMORY.md` 의 Taskminal 줄 갱신
10. 바로 다음 단계로.

## 4. 명령

| 할 일 | 명령 |
|---|---|
| 전체 검사 | `bash ~/.claude/skills/harness-engineering/stacks/electron/scripts/full-check.sh [로그]` |
| 타입 | `npm run typecheck` |
| 단위 | `npx vitest run [파일]` |
| e2e 하나 | `npm run build && npx playwright test tests/e2e/x.spec.ts -g <이름> --reporter=line` |
| 경계 | `node ~/.claude/skills/harness-engineering/stacks/electron/templates/tool/check-boundaries.mjs` (프로젝트 `tool/` 없음) |
| 개발 실행 | `npm run dev` — **실제 데이터 폴더를 쓴다**. 사용자가 직접 볼 때만 |

## 5. 지킬 것

- e2e 는 `TASKMINAL_USER_DATA=<임시 폴더>` 로만 앱을 띄운다. 앱은 `args: ['.']` (out/main/index.js 직접 주면 앱 이름이 Electron 이 된다).
- e2e 상태는 `tests/e2e/helpers.ts` 의 `seedState` 로 깐다(기본 `confirmQuit:false` — 켜져 있으면 실행 중 셸 때문에 `app.close` 가 대화상자에서 멈춘다).
- **사용자가 `npm run dev` 로 앱을 띄워 둔 동안 `~/taskminal` 의 src 를 고치지 않는다** — 화면을 다시 읽어 셸이 모두 끝난다. 그때는 `git worktree add ../taskminal-work stage-N-…` 같은 별도 폴더에서 일한다(그 폴더에서 `npm ci` 필요 · node-pty postinstall 이 spawn-helper 권한을 고친다).
- `rm -rf` 는 가드 훅이 막는다 — 파일을 하나씩 지운다. zsh 글롭은 따옴표(`--include='*.ts'`).
- 다른 파일을 일부러 남기고 커밋할 때: `HARNESS_PARTIAL_COMMIT=1 git commit …`
- renderer → node/electron import 금지(경계 검사). preload API 는 동작 단위로 좁게, main IPC 는 renderer 값을 검사(`isPaneId` · 크기 상한).

## 6. 단계별 메모

### 13 재시작 복원
계획 `docs/stages/13-restore.md`. 짚어 둔 함정:
- `TerminalPane` 의 effect 의존성이 `[paneId, cwd]` — OSC 7 로 pane.cwd 를 갱신하면 터미널이 통째로 다시 만들어진다 → cwd 는 ref 로, 띄울 때만.
- 되살린 글은 OSC 가 없어 시작 명령(12단계)이 다시 돌지 않는다 — 그래도 e2e 로 확인.
- 스크롤 저장 파일은 비밀값이 섞일 수 있다 → 0600 · 끄면 모두 지움.

### 14 패키징 · 설치
- **앱 아이콘: `resources/icon/icon.svg`** (2026-11-10 사용자 결정 — C1 모양 · 보라, 디자인 캔버스 '앱 아이콘' 보드). 1024 PNG 로 그린 뒤(Electron/Playwright 로 렌더) `iconutil` 로 `.icns`(16~1024 @1x·@2x) → electron-builder `mac.icon`. 개발 모드 Dock 아이콘(`app.dock.setIcon`)도 같은 그림으로.
- electron-builder `.app`(arm64) · `asarUnpack` node-pty(+ `spawn-helper` 실행 권한 — 빠지면 `posix_spawnp failed`, `scripts/fix-node-pty.mjs` 참고) · 셸 통합 `resources/shell/zsh` 를 `extraResources` 로 `Resources/shell/zsh` 에(main 이 `app.isPackaged` 면 그 경로를 본다, `src/main/index.ts` 위쪽).
- Finder 로 띄우면 PATH · LANG 이 비어 있다 → 로그인 셸에서 환경을 읽어 오거나 셸을 `-l` 로(이미 `-l`) — `which node` · 한글을 설치본에서 확인.
- 네이티브 모듈은 Electron ABI 와 패키징까지 확인해야 "된다" 고 쓴다(`ELECTRON_RUN_AS_NODE=1 …` 로 확인).
- `/Applications` 에 복사하는 실제 설치는 **사용자 확인 뒤**. 그 전까지는 `dist/` 의 .app 을 임시 데이터 폴더로 띄워 확인.

### 15 다듬기
항목마다 따로 계획(`docs/stages/15a-…` 처럼): 보이는 pane 만 WebGL · ⌘F 검색 · 명령 끝 macOS 알림 · git worktree 일감 · 링크 열기 · 일감 브랜치 표시. 11단계에 알림 설정이 이미 있으니 '명령 끝 알림' 은 겹치는지 먼저 본다.

### 16 셸 지킴이
계획 `docs/stages/16-persist.md`. 구조: `src/main/ptyhost/`(host-entry = 지킴이 진입 · host-core = 세션 · headless · client = 앱 쪽 손님) · `src/main/host-control.ts`(상태 · 끝내기 · 메모리 · 옛 버전) · `src/main/pty-manager.ts`(지킴이에 요청). 짚어 둔 함정:
- 패키지에서 node-pty 는 `app.asar` 경로로 require 한다 — `app.asar.unpacked` 로 주면 helper 경로가 `.unpacked.unpacked` 가 되어 `posix_spawnp failed`.
- e2e 는 `TASKMINAL_QUIT_NOTICE=seen` 이 기본(playwright 설정) — 처음 ⌘Q 안내가 시험 정리를 막지 않게. 그 안내를 보는 시험만 지운다.
- 지킴이는 userData 폴더 · 소켓이 사라지면 2초 안에 스스로 끝난다(e2e 임시 폴더 정리 = 지킴이 정리). 손님 · 살아 있는 셸이 없으면 60초 뒤 끝남.
- ⌥⌘Q 는 `ptys.clear()` 뒤 지킴이를 끈다 — 먼저 끄면 셸 exit 가 창으로 가서 pane 이 지워지거나 '셸이 끝났습니다' 가 저장된다.
- 키 없는 명령(⌘P 전용)은 메뉴에 없다 — 메뉴 대조 시험은 키 있는 명령만.

### 17 데이터 안전
계획 `docs/stages/17-safety.md`. 구조: `src/shared/redact.ts`(가리기 — 디스크로 가는 새 길은 꼭 이것을 부른다: 19 명령 기록 · 21 대화 · 24 CLI read) · `src/shared/backup.ts`(보존 · 비교 · 되살리기 순수) · `src/main/backup-store.ts` · `src/renderer/secret-mask.ts`. 짚어 둔 함정:
- 백업은 main 의 상태 쓰기 직전에 판단한다(renderer 를 믿지 않음). 자동 이유는 같은 내용이면 건너뛰고, 사용자가 부른 '되돌리기 전 · 가져오기 전' 은 `force` 로 늘 만든다.
- 이미 남은 스크롤 파일 정리 표시 파일은 `scrollback/` 밖(`scrollback-redacted-v1`) — 안에 두면 live 정리가 .txt 아닌 것을 지운다.
- `grep --color` 출력은 토큰 한가운데 색 코드가 낀다 → redact 는 ANSI 를 걷어 낸 글에서 찾고 원래 위치로 되돌린다.
- 되돌리기 뒤 다시 마운트된 TerminalPane 이 설정 창 포커스를 빼앗았다 → `aria-modal` 이 열려 있으면 포커스를 가져가지 않는다.
- 단축키를 키 표에 더하면 앱 메뉴(`src/main/menu.ts`)에도 넣는다 — `keys.spec` 메뉴 대조 시험이 잡는다.

### 18 출시 기본기
계획 · 결과 `docs/stages/18-release.md`. 구조: `src/shared/update.ts`(버전 비교 · 요약 · 오류 글 · 막힌 자리) · `src/main/updater.ts`(Updater — 엔진을 감싼 상태, 시험은 가짜 엔진) · `src/shared/errlog.ts` + `src/main/errlog.ts`(오류 기록) · `src/renderer/update-ui.tsx` · `settings/AboutSection.tsx` · `FirstRun.tsx` · `scripts/release.mjs`(배포 빌드). 짚어 둔 함정:
- 업데이트 받는 곳은 GitHub Releases `petercorders/taskminal`(사용자 결정, NAS 대신). 게시 · push 는 사용자 확인 뒤.
- `app-update.yml` 은 electron-builder 가 macOS 에서 dmg · zip 대상일 때만 넣는다 — `npm run package`(dir) 결과물엔 없고, 그런 빌드는 업데이트를 '확인하지 않음' 으로 둔다. 검사는 `check-package --release`.
- e2e 업데이트는 `TASKMINAL_UPDATE_FEED=<로컬 http>` + `TASKMINAL_UPDATE_FIRST_MS` — 실제 electron-updater 가 받고, 받은 파일은 `<userData>/caches`. 서명 없는 개발 앱은 Squirrel 설치가 실패하는 길만 볼 수 있다.
- crashReporter 는 임시 userData(e2e)에서 켜지 않는다 — crashpad_handler 가 stdio 를 물고 남아 `app.close()` 가 끝나지 않는다(기존 e2e 가 모두 멈췄다).
- 사이드바는 상태를 읽는 중에도 그려진다 · 그 사이 온 명령(메뉴 · app:command)은 버린다 → e2e 는 `waitLoaded(win)`(tests/e2e/helpers.ts) 뒤에 명령을 보낸다.
- 첫 실행 안내는 state.json 이 없고 `<userData>/first-run-seen` 이 없을 때만 — e2e 는 `TASKMINAL_FIRST_RUN=seen` 이 기본(playwright 설정), 안내를 보는 시험만 지운다.
- renderer 에 여는 API 를 늘리면 `window.spec` 의 허용 목록도 고친다(보안 기본값 시험).

### 19 기록과 찾기
계획 · 결과 `docs/stages/19-history.md`. 구조: `src/shared/history.ts`(기록 모양 · 거르기 · 날짜 묶음 · 꼬리 · `hasMask` · `safeToInsert`) · `src/shared/global-find.ts`(찾기 · 가린 글 판정) · `src/shared/danger.ts`(위험 명령 — 20단계 빠른 명령이 같은 표) · `src/main/history-store.ts` · `src/renderer/history-state.ts`(useHistory — 대기열 · 숨김) · `history-ui.tsx` · `GlobalFind.tsx`. 짚어 둔 함정:
- 기록 · 찾기 미리보기에 원문 비밀값이 나가지 않게 — 명령 · 꼬리 · **고른 줄의 앞뒤 줄**까지 가린 글로(앞뒤 줄은 처음에 원문이었다, 스크린샷으로 찾음).
- '넣기만' 은 `term.paste` 에 기댄다 — 셸이 괄호 붙여넣기(2004)를 켜지 않았으면 xterm 이 \n 을 \r 로 보내 여러 줄이 실행된다 → `safeToInsert` 로 막는다.
- 저장 전에 가린 명령(‹가림:…›)은 다시 실행하면 가린 글자가 실행된다 → ⌥↩ 도 넣기만.
- 칸 · 단추에 글자 폭(auto)을 주면 탭 줄 폭이 소수 px 가 되어 `tabs.spec` 넘침 시험(비율 1)이 깨진다 → 정수 폭.
- 터미널의 가린 칸 꾸밈(xterm z-index 7)이 좁아진 본문 밖으로 넘친다 → 옆 칸은 `z-index` 를 더 높게.
- 셸 지킴이에 다시 붙은 셸은 새 프롬프트 전에 133 신호가 없다 — '통합 없음' 을 133 만으로 판정하지 않는다.
- 알림(Toast)의 `onEnd(undone)` — 되돌리기를 놓친 뒤 할 일(파일 지우기)은 여기서. 창이 내려갈 때도 부른다.

### 디자인 맞추기 (단계 아님)
`docs/design-gaps.md` 를 사용자가 고치는 중. 15단계 뒤 그 문서로 단계를 나눈다. 디자인 캔버스 파일은 Artifact 도구 read 로 받는다(`project/Main.dc.html` 등).

## 7. 이미 겪은 함정

- Playwright `expect.poll` 은 콜백이 throw 하면 다시 시도하지 않는다 → `?.` 로 undefined 를 돌려준다.
- Playwright 는 페이지 포커스를 흉내 내 `document.hasFocus()` 를 못 낮춘다 · 합성 키는 네이티브 메뉴 단축키를 부르지 않는다.
- 18단계부터 전체 e2e 첫 실행에서 `safety.spec.ts:48`(되살린 일감에 `echo BACK…`)이 명령 글자만 찍히고 5초 안에 출력이 없어 실패하고, 다시 돌리면 통과한다(전체 실행 4번 중 3번, 마지막 한 번은 처음부터 통과). 앞 71개만 같은 순서로 돌리면 재현 안 됨 — 원인 미확인. 19단계 전체 실행 3번 중 1번 다시 나옴: 받은 화면이 `echo BACK$((1+1)) ` 뿐 — **프롬프트가 한 번도 안 그려졌다**(입력은 tty 가 되돌린 글자). 시험은 프롬프트를 기다리지 않고 친다. 지킴이 `spawn` 은 같은 paneId 의 끝나지 않은 세션이 있으면 그 세션에 붙는다(`host-core.ts` spawn 의 `old && !old.exited`) — 지운 B 의 셸(SIGHUP · 2초 뒤 SIGKILL)과 되살린 B 가 같은 `p2` 를 쓰므로 후보지만, 지우기 → 되살리기 사이가 몇 초라 확인 못 함. 다음에 볼 것: 실패 때 지킴이 `list` 로 p2 세션의 pid · killed · 시작 시각을 남기기.
- e2e 전체 실행에서 가끔 앱 창이 안 뜬다(원인 미확인, `test-results/launch-hangs/log.txt` 에 쌓임) → full-check 가 다시 돌려 '불안정(3)' 으로 나눈다. 보고에 적는다.
- e2e `win.evaluate` 안에서는 `window` 대신 `globalThis`(tsconfig.node 에 DOM 이 없다).
- 변이 목록의 `\n` 은 줄바꿈 — 코드의 글자 그대로 `\n` 은 `\\n`.
- python 등으로 파일을 고치면 편집 훅(tsc)이 돌지 않는다 → 고친 뒤 `npm run typecheck`.
- 열린 대화상자 · `then` 이 가리키는 대상이 그 사이 사라질 수 있다 — 저장할 내용은 연 순간에 떠 두고, 지울 대상은 id 로 다시 찾는다(12단계 리뷰).
