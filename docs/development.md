# Taskminal 개발 진행 문서

이 문서만 읽고 다음 단계를 이어 갈 수 있게 쓴다. 단계의 범위 · verify 는 `docs/plan.md`, 단계별 상세 계획은 `docs/stages/`.
마지막 갱신: 2026-11-11 (e2e 고침 병합 — 13~15 e2e 전체 통과 115개 · 14단계 .app 임시 데이터 폴더 실행 확인, 16단계 진행 중)

## 1. 지금 어디까지

| 단계 | 상태 |
|---|---|
| 0~12 | 끝, `main` 에 병합 (12단계 = main `3d570ab`) |
| 13 재시작 복원 | **단위까지 확인 · e2e 미실행** — main 에 병합. 브랜치 이름은 `stage-13`(worktree `~/taskminal-work`, ~/taskminal 의 `stage-13-restore` 는 그 앞 문서 브랜치). e2e 는 사용자 지시(2026-11-10 "지금 실제 테스트는 하지마")로 돌리지 않음 — 돌려야 할 목록은 `docs/stages/13-restore.md` 결과 절 |
| 14 패키징 · 설치 | main 에 병합(브랜치 `stage-14-package`). `npm run package` 로 `dist/mac-arm64/Taskminal.app` + 정적 검사. 2026-11-11 임시 데이터 폴더로 .app 실행 확인(셸 · 한글 · 최소 환경 `which node` · 아이콘 · 패키지 node-pty) — Finder 더블클릭 · /Applications 설치는 사용자 확인 대상. `docs/stages/14-package.md` 결과 절 '실행 확인' |
| 15 다듬기 | **단위까지 확인 · e2e 미실행** — main 에 병합(브랜치 `stage-15-polish`). 15a~15f 항목별 문서(`docs/stages/15a-notify.md` ~ `15f-worktree.md`) 결과 절에 돌려야 할 e2e. playwright 설정이 기본 `TASKMINAL_RENDERER=dom`(15e) — 기존 e2e 전체도 다시 |
| 13~15 e2e | 2026-11-11 브랜치 `stage-15-e2e-fix`(e2e 고침 3커밋) 로 전체 검사 통과(e2e 115개) → main ff 병합 `73c70cd` |
| 16~25 1차 출시 | 16 진행 중 — `docs/plan.md` "1차 출시까지" 표 · 보드는 디자인 캔버스 1차 출시 구역(2026-11-11 추천안 채택) |
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

### 디자인 맞추기 (단계 아님)
`docs/design-gaps.md` 를 사용자가 고치는 중. 15단계 뒤 그 문서로 단계를 나눈다. 디자인 캔버스 파일은 Artifact 도구 read 로 받는다(`project/Main.dc.html` 등).

## 7. 이미 겪은 함정

- Playwright `expect.poll` 은 콜백이 throw 하면 다시 시도하지 않는다 → `?.` 로 undefined 를 돌려준다.
- Playwright 는 페이지 포커스를 흉내 내 `document.hasFocus()` 를 못 낮춘다 · 합성 키는 네이티브 메뉴 단축키를 부르지 않는다.
- e2e 전체 실행에서 가끔 앱 창이 안 뜬다(원인 미확인, `test-results/launch-hangs/log.txt` 에 쌓임) → full-check 가 다시 돌려 '불안정(3)' 으로 나눈다. 보고에 적는다.
- e2e `win.evaluate` 안에서는 `window` 대신 `globalThis`(tsconfig.node 에 DOM 이 없다).
- 변이 목록의 `\n` 은 줄바꿈 — 코드의 글자 그대로 `\n` 은 `\\n`.
- python 등으로 파일을 고치면 편집 훅(tsc)이 돌지 않는다 → 고친 뒤 `npm run typecheck`.
- 열린 대화상자 · `then` 이 가리키는 대상이 그 사이 사라질 수 있다 — 저장할 내용은 연 순간에 떠 두고, 지울 대상은 id 로 다시 찾는다(12단계 리뷰).
