# Taskminal 개발 진행 문서

이 문서만 읽고 다음 단계를 이어 갈 수 있게 쓴다. 단계의 범위 · verify 는 `docs/plan.md`, 단계별 상세 계획은 `docs/stages/`.
마지막 갱신: 2026-11-12 (27단계 UX 감사 · 다듬기 병합 — 배율 1 에서 DOM 렌더러 · 첫 실행 대화. 26단계: 새 일감은 대화로 시작 · ⌘J 셸. 1차 출시까지 남은 것은 8절: 서명 · 공증(사용자 준비물 뒤 `npm run release`) · 설치 · 미확인 목록)

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
| 20 빠른 명령 · 포트 | main 에 병합(브랜치 `stage-20-quick-ports`). 빠른 명령 단추 줄(일감 · 템플릿 · 모든 일감, ⌥1~9, ⌘P) · 포트 칩(탭 · 사이드바 · ⌘P · 끄기 · 숨기기 · 겹침 막대). 계획 · 결과 `docs/stages/20-quick-ports.md` |
| 21 대화 1 — Claude · 사이드바 | main 에 병합(브랜치 `stage-21-chat-claude`). 대화 pane(가짜 claude 로 e2e · stream-json · 허락/질문 카드 · `--resume` · 허락 방식 · ⇧⌘J 터미널 전환 · 가린 대화 기록 `<userData>/chat/*.jsonl`) + 사이드바 흐름 보기(상태 칸 · 개수 막대 · `/` 거르기 · 끌어 놓기 · 안 본 점). 계획 · 결과 `docs/stages/21-chat-claude.md` |
| 22 대화 2 — Codex · 확장 | main 에 병합(브랜치 `stage-22-chat-codex`). Codex app-server 대화(가짜 codex 로 e2e · 같은 카드로 승인 · 로그인 없음 띠 · `thread/resume`) · 그림(📎 · ⌘V · 끌어 놓기) · 되감기 · 여기서 새 대화로 나누기(둘 다 앞 턴 끝에서 갈라진 새 세션, 파일은 그대로) · 대기열 · ⌘↩ 지금 보내기 · 여러 개 고르기. Codex 승인 · 질문 · 항목 줄은 로그인한 codex 로 **미확인**. 계획 · 결과 `docs/stages/22-chat-codex.md` |
| 23 변경 검토 | main 에 병합(브랜치 `stage-23-review`). pane 종류 '변경'(⇧⌘G · ⌘P): 파일별 diff · 줄 골라 ⌫ 되돌리기(⌘Z · '되돌린 것' 7일, add 한 파일은 인덱스도 함께) · 체크한 파일만 `commit --only` · 막을 때만 경고(main 에 바로 · 비밀값) · 커밋 전 검사 실패 마지막 20줄 · 커밋 취소 · 대화 도구 줄의 'diff 열기 →' 카드 · 보일 때만 폴더 감시. 전체 보기 '± 변경' 칩은 그 화면이 없어 안 함. 계획 · 결과 `docs/stages/23-review.md` |
| 24 지휘와 이어받기 | main 에 병합(브랜치 `stage-24-cli-resume`). `taskminal` 명령(`resources/bin/taskminal` → `out/main/cli.js`, 소켓 `<userData>/cli.sock` 0600): 일감 · 탭 · pane 바꾸기 · `pane send/read/wait` · `chat new/send/wait/read` · `notify` · `task note`, 앱 메뉴 '명령줄 도구 설치…' 로만 PATH 링크. 오래 안 본 일감의 이어받기 요약 카드(⌥⌘R) · 일감 메모 칸(⌥⌘M). 계획 · 결과 `docs/stages/24-cli-resume.md` |
| 25 보관 · 원격 | main 에 병합(브랜치 `stage-25-archive-remote`, 25a `6788a08` · 25b `167cc7f` + 리뷰 고침). 보관함 ⇧⌘E(⌥⌘A 보관 · 되살리기 · 최근 지운 것 30일) · 주간 정리 · SSH 원격 일감(새 일감 ⌥2 · ControlMaster · tmux 이어 붙기 · 다시 붙기 다섯 번 · 호스트 키 띠). 24단계 친 글자 모으기(2340b45) 리뷰 고침도 이 브랜치. 계획 · 결과 `docs/stages/25-archive-remote.md` |
| 26 대화 중심 · 가독성 | main 에 병합(브랜치 `stage-26-chat-first`, 26a 메뉴 · 탭 ▾ · 26b·c 대화 중심 · 가독성 · 26d 리뷰 고침). 새 일감 기본 = Claude 대화(설정 › 일반 › 새 일감 시작) · ⌘J 셸 꺼내기 · 빈 화면 단추 · 사이드바 '대화 N · 셸 M' · 글자 12px 이상 · 대비 4.5 이상. 계획 · 결과 `docs/stages/26-chat-first.md` |
| 27 UX 감사 · 다듬기 | main 에 병합(브랜치 `stage-27-ux-polish`). 화면 30장 감사 · 8기준 72.5 → 84.4(두 번 상한). 배율 1 은 DOM 렌더러 · 첫 실행 대화로 · 대화 탭의 빠른 명령 띠 숨김 · 탭 이름 유지 · 번호 · 'TUI 로'. `docs/stages/27-ux-polish.md` |
| 1차 출시 | **남은 것은 사용자 손 · 실제 환경** — 8절 |
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

### 20 빠른 명령 · 포트
계획 · 결과 `docs/stages/20-quick-ports.md`. 구조: `src/shared/quick.ts`(검증 · 단추 순서 · `advanceRun` / `closeRun` / `quickStatus` · `decideRun`) · `src/shared/ports.ts`(ps · lsof 읽기 · `portsByPane` · `mergePorts` · `portConflict` · `createPortPoller`) · `src/main/port-probe.ts`(`probePorts` · `killPort`) · `src/renderer/quick-ui.tsx` · `ports-ui.tsx` · `ports-state.ts`(usePorts) · `PopupMenu.tsx`(HTML 메뉴 — Playwright 가 누를 수 있게). 짚어 둔 함정:
- 단추 상태는 실행마다 시작 · 끝을 처음 본 순간에 굳힌다 — pane 활동만 보면 같은 pane 의 다음 명령이 앞 단추를 ✗ 로 바꾼다(스크린샷으로 찾음). pane 이 닫히면 `closeRun`.
- 알림(Toast)의 단추는 ⌘Z 를 받는다(되돌리기 자리) — 되돌리기가 아닌 단추(열기 등)를 알림에 두지 않는다.
- 포트 조사: 셸 자손 pid 를 ps 로 먼저 모으고 `lsof -a -p` 로 좁힌다(자손이 없으면 안 부름). 같은 포트를 주인 · 일꾼이 들으면 주인 pid. 조사는 한 번에 하나 · 세대(`invalidate`) · 끄기 뒤 다시 묻기는 `afterCurrent`.
- e2e 포트 주기는 `TASKMINAL_PORT_POLL_MS`(기본 3000), openExternal 은 main 에서 가짜로 바꿔 받은 주소를 센다 — 주소 끝에 `/` 가 붙는다.
- ⌥숫자는 물리 키(`e.code` DigitN)로 잡는다. 'Option 을 Meta 로' 면 가로채지 않는다. 한글 입력기 켠 실제 키는 미확인.
- 단위 시험에서 '다른 pane' 의 pid 로 1 을 쓰지 않는다(모든 프로세스의 조상) — 형제 `sleep` 을 띄운다. 없는 pid 는 `process.kill` 이 던져 검사 없이도 통과한다(변이에서 드러남).
- 템플릿 JSON 편집(`replaceTemplate`)은 칸을 펼쳐 담는다 — 골라 담으면 새 칸(quickCommands)이 지워진다.

### 21 대화 1 — Claude · 사이드바 흐름 보기
계획 · 결과 `docs/stages/21-chat-claude.md`(0절 스파이크 표 = claude stream-json 줄 모양). 구조: `src/shared/chat.ts`(이벤트 · 변환 · `foldBlocks` · `chatStatus` · `redactEvent`) · `src/main/chat/`(`claude-adapter.ts` 프로세스 하나 · `chat-manager.ts` pane 마다 · `chat-store.ts` 가린 기록 · `find-bin.ts`) · `src/renderer/ChatPane.tsx` · `sidebar-model.ts`(`flowSections` · `countBar` · `unreadTasks` · `lastLine`). 짚어 둔 함정:
- e2e 는 `TASKMINAL_CLAUDE_BIN=tests/fixtures/fake-claude.mjs`(보낸 글의 낱말로 대본) · `FAKE_CLAUDE_LOG`(인자 · stdin) · 터미널 전환은 `TASKMINAL_CLAUDE_TUI`. `shellEnv` 가 TASKMINAL_* 를 지우므로 가짜에 줄 값은 다른 이름으로. 로그인 셸은 PATH 앞에 가짜 폴더를 끼워도 실제 `~/.local/bin/claude` 를 찾는다.
- 화면 · 디스크 둘 다 가린 사본, claude 로는 원문. 질문 답 키는 가린 글이라 adapter 가 원래 질문 글로 되돌린다. 위험 판정은 main(adapter)도 다시 한다 — '늘 허락' 단추를 숨기는 것만으로 믿지 않는다.
- 이벤트 번호(pane 마다) + `history → {events, upTo}`: 화면은 번호 > upTo 인 실시간 이벤트만 붙인다. upTo 는 읽기 **전에** 잡는다.
- 앱이 턴 도중 끝나면 '멈춤' 을 못 쓴다 → `history` 가 프로세스 없는 열린 턴을 멈춤으로 닫는다(리뷰가 찾음, 안 하면 '실행 중' 에 굳음).
- claude stdin 에는 'error' 받는 이를 단다(EPIPE 는 늦게 와 main 을 죽인다). 찾는 사이 닫힌 pane 은 띄우지 않고, 닫은 entry 의 늦은 이벤트는 기록하지 않는다.
- claude 찾기는 `-lc` → 못 찾으면 `-ilc`(zsh 는 비대화형이면 .zshrc 를 안 읽음).
- 사이드바 기본이 흐름 보기 — 묶음을 보는 e2e 는 `sidebarView: 'group'` 으로 띄우거나 '묶음' 단추를 누른다. 불러오기 전에는 흐름 칸을 그리지 않는다(기본 설정으로 번쩍여 재시작 시험의 locator 가 엉뚱한 칸을 잡았다).
- 메뉴 이름이 일감 이름보다 ⌘P 순위가 높으면 palette 시험이 깨진다('일감 거르기' → '사이드바에서 거르기').

### 22 대화 2 — Codex · 확장
계획 · 결과 `docs/stages/22-chat-codex.md`(0절 스파이크 = codex-cli 0.167.1 app-server · claude 2.1.322 fork). 구조: `src/main/chat/session.ts`(`AgentSession` 겉모양) · `codex-adapter.ts`(`CodexSession`) · `src/shared/chat.ts` 의 `codexNoteToEvents` · `codexRequestToEvents` · `codexPolicy` · `rewindPlan`. 짚어 둔 함정:
- e2e 는 `TASKMINAL_CODEX_BIN=tests/fixtures/fake-codex.mjs`(JSON-RPC 대본) · `FAKE_CODEX_LOG` · `FAKE_CODEX_NOLOGIN=1`. 그림 고르기는 `app.evaluate` 로 `dialog.showOpenDialog` 를 바꿔 시험한다.
- app-server 줄에는 `"jsonrpc"` 칸이 없다. 로그인이 없으면 turn/start 가 401 을 15초쯤 되풀이 → 띄울 때 `account/read` 로 먼저 막는다. 스레드를 못 열면 프로세스를 떼어 낸다(남기면 threadId 없이 turn/start 만 되풀이 — 리뷰).
- 되감기 · 나누기 anchor = Claude 는 턴의 마지막 assistant `uuid`(`--fork-session --resume-session-at`, 숨은 플래그), Codex 는 turn id(`thread/fork lastTurnId`). anchor 가 난 세션은 기록의 마지막 `session` 이벤트로 찾는다 — 한 번 갈라진 뒤 앞 턴 anchor 를 새 세션에 쓰면 못 찾는다. 앞 턴이 anchor 없이 끝났으면 되감지 않는다.
- 창이 보낸 메시지 번호는 저장 파일과 어긋날 수 있다(파일 앞 잘림) — main 은 보낸 시각(`at`)으로 다시 찾는다.
- 사용자 말풍선에 hover 단추를 display none 으로 넣으면 올렸다 내릴 때 목록 높이가 바뀌어 클릭이 빗나간다 → 바깥에 absolute · visibility. 말풍선 글을 보는 시험은 `chat-user-text` 를 본다(단추 글이 섞인다).
- 같은 글의 카드가 둘이면 `.last()` 가 첫 카드를 잡은 채 기다린다 — 개수로 먼저 기다린다.
- ⌘P '새 대화' 는 Codex 가 위(짧은 이름 점수). 대화 e2e 는 '새 대화 (Claude)' 로 고른다.

### 23 변경 검토
계획 · 결과 `docs/stages/23-review.md`(0절 스파이크 = fs.watch 비용 · 문맥 방식 역패치 · 서명 기다림). 구조: `src/shared/review.ts`(해석 · `buildPatch` · 경고) · `src/main/review-git.ts`(git CLI · `RevertStore` · `ReviewWatch`) · `src/renderer/ReviewPane.tsx`. 짚어 둔 함정:
- 패치는 renderer 가 보내지 않는다 — renderer 는 경로 · 표지(`fileSig`) · 줄 키(`덩어리:줄`)만, main 이 다시 읽어 표지가 다르면 거절한다. 경로는 `safeRel` + 바뀐 파일 목록 둘 다, 편집기로 열기는 `safeRel` 만 보므로 직접 시험이 있다(변이에서 드러남).
- 편집기로 열기는 `/usr/bin/open -t` — `shell.openPath` 는 `.command` · `.app` 을 실행한다.
- git 은 `LC_ALL=C` · `GIT_TERMINAL_PROMPT=0` · `GIT_OPTIONAL_LOCKS=0` · `GIT_LITERAL_PATHSPECS=1` · `core.quotepath=false`. e2e 저장소는 로컬 설정으로 서명을 끈다(전역 설정은 건드리지 않는다).
- e2e 에서 diff 줄을 글자로 찾지 않는다 — `hasText` 는 대소문자를 가리지 않아 `b` · `B` 가 겹친다. `[data-key="덩어리:줄"]` 로 찾는다.
- 막 연 pane 은 첫 읽기 전이라 커밋 칸이 없다 — 포커스 요청은 기억했다가 그려진 뒤에 준다.
- macOS 임시 폴더는 `/var` → `/private/var` — git 이 돌려주는 뿌리와 비교하는 단위 시험은 `realpathSync(mkdtempSync(…))`.

### 24 지휘와 이어받기
계획 · 결과 `docs/stages/24-cli-resume.md`(0절 스파이크 = Claude Code 의 OSC 9 는 알려진 터미널에만 · 소켓 권한). 구조: `src/shared/cli.ts`(인자 · 요청 검증 · 이름 풀기 · list) · `src/shared/pane-watch.ts`(OSC 133 으로 pane wait, 가짜 시계) · `src/main/cli-server.ts`(소켓 · 창에 묻기 · 지킴이 · 대화) · `src/main/cli/cli-entry.ts`(명령 쪽) · `src/renderer/cli-bridge.ts`(창이 하는 일, reducer 동작) · `src/shared/resume.ts` · `ResumeCard.tsx` · `NotesPanel.tsx`. 짚어 둔 함정:
- e2e 는 `runCli(userData, …)`(helpers) 로 저장소의 `resources/bin/taskminal` 을 부른다 — 시험 환경의 `TASKMINAL_*` 를 빼야 바깥 셸처럼 된다. `npm run build` 뒤에(`out/main/cli.js`).
- 확인 필요인 일감은 사이드바 위 '확인 필요' 칸으로 옮겨 가 `task-row` 가 사라진다(`attention-row`) — 일감 줄은 `li[data-task-name=…]` 로 찾는다.
- e2e 에서 앱을 다시 띄우면 `win` 이 바뀐다 — 미리 만든 locator 는 옛 창을 본다. 부를 때마다 만든다.
- 요약 카드는 '보면 꺼지는 확인 필요' 보다 먼저 계산해야 한다 — App 의 효과 선언 순서(이어받기 효과가 `viewedPane` 효과 위)에 기댄다. 카드는 연 순간의 사실을 떠 둔다.
- `process.umask` 는 프로세스 전체 — await 를 넘겨 두지 않는다(유닉스 소켓은 `listen()` 호출 안에서 bind).
- 명령이 만든 탭 · pane 은 사용자가 보던 탭 · pane 으로 되돌린다(`keepFocus`) — 치던 키가 다른 pane 으로 가지 않게.
- 커밋을 둘로 나눌 때 한 파일에 두 기능이 섞이면 hunk 대신 그 커밋용 파일을 만들어 `git update-index --cacheinfo` 로 올리고, `git checkout-index -a --prefix=<임시>` + node_modules 링크로 그 트리를 따로 컴파일했다.

### 25 보관 · 원격
계획 · 결과 `docs/stages/25-archive-remote.md`(0절 스파이크 = 일감별 AI 토큰 원천 없음 · Finder 실행의 `SSH_AUTH_SOCK` 은 launchd 소켓 · Synology 미확인). 구조: `src/shared/archive.ts`(보관 · 되살리기 · 제안 · 찾기 · 최근 지운 것) · `src/shared/weekly.ts`(월요일 시작 주 · 요약 · 마크다운) · `src/shared/remote.ts`(호스트 검사 · ssh 인자 · 원격 명령 · ssh 알림 · 다시 붙기 걸음 · 소켓 경로 한도) · `ArchivePanel.tsx` · `WeeklyPanel.tsx` · `RemoteBand.tsx` · `TerminalPane` 의 원격 다시 붙기. 짚어 둔 함정:
- 보관 일감은 `viewState`(App)로 화면 · 사이드바 · ⌘P · 다음 일감에서 뺀다 — `state.tasks` 를 직접 도는 새 코드는 보관 일감을 함께 본다.
- '지움' 백업은 지우기 직전 모습이 시작 · 자동 백업과 같으면 따로 생기지 않는다 → 최근 지운 것은 이유를 가리지 않고 모든 백업에서 찾는다.
- CLI `task remove` 는 열린 대화상자를 모두 닫는다(`remove()` → `closeDialogs`) — 확인 창이 떠 있는 시험은 그걸 기대한다.
- 원격 시험은 가짜 ssh(`TASKMINAL_SSH` 절대 경로 · `TASKMINAL_SSH_CONFIG` · `TASKMINAL_SSH_RETRY_MS`)로 — pane 환경에서 `TASKMINAL_*` 가 빠지므로 가짜는 자기 옆 `mode` 파일을 읽는다. 원격 셸에서 `exit 255` 를 치면 끊김이 된다.
- ssh 알림은 '끝난 결과(키 바뀜 · 거절 · 인증) → 질문' 순서로 본다. 질문 뒤 출력은 새로 모은다.
- ControlPath 는 macOS 소켓 경로 104바이트 안에 — 보통 `<userData>/ssh` 는 넘쳐 `/tmp/taskminal-<uid>` 로 간다(e2e 임시 폴더도 길다).
- 원격 일감은 템플릿을 쓰지 않는다 · 대화(⇧⌘J) · 변경 검토는 막지 않았다(이 Mac 에서 원격 경로로 돈다 — 8절).

### 26 대화 중심 · 가독성
계획 · 결과 `docs/stages/26-chat-first.md`('참고: Orca' 표 · 가독성 전후 표). 구조: `NewTaskInput.start` · `Settings.newTaskStart` · `shellToggle`(`src/shared/model.ts`) · `paneCountLabel`(`src/renderer/sidebar-model.ts`) · `tests/e2e/readability.spec.ts`(화면마다 글자 크기 · WCAG 대비 · 줄 간격을 재고 `test-results/readability/` 에 남김). 짚어 둔 함정:
- 단축키 표는 ⌘ 없는 키를 받지 않는다(⌃\` 대신 ⌘J). 글 입력칸에서는 ⌘ 키가 칸의 몫이라 앱이 안 받는다 — 대화 입력칸의 ⌘J 만 예외로 받는다.
- `createTask` 는 `start` 가 없으면 셸 — CLI · 옛 호출 그대로. e2e seed 설정은 `newTaskStart: 'terminal'`(helpers) — 새 시험이 대화 시작을 보려면 설정으로 넘긴다.
- 글자 크기를 바꾸면 터미널 맞춤이 늦어져 열린 팔레트의 포커스를 가져갈 수 있었다 → 팔레트는 `aria-modal`(뒤 칸의 포커스 효과가 건너뜀).
- styles.css 의 글자 크기는 이제 12px 아래가 없다 — 새 화면도 readability e2e 기준(12 · 본문 14 · 대비 4.5 · 줄 간격 1.4)을 지킨다.

### 27 UX 감사 · 다듬기
계획 · 결과 `docs/stages/27-ux-polish.md`(기준 8개 채점 72.5 → 84.4 · 찾은 것 표). 짚어 둔 함정:
- **WebGL 은 화면 배율 2 미만에서 쓰지 않는다**(`webglBlock` 'lowdpi' — 배율 1 에서 글자가 작고 띄엄띄엄). e2e 는 DOM 렌더러라 이걸 못 본다 — 터미널 모양은 `TASKMINAL_RENDERER` 를 비우고 실제 화면으로 찍어 본다.
- `TASKMINAL_RENDERER=webgl` 은 이제 'webgl-always'(배율 무시) — WebGL 시험용. 기본(값 없음)은 배율로 고른다.
- 탭 이름은 대화가 있는 탭이면 대화 이름(⌘J 셸 · 변경 칸에 포커스가 가도), 겹치면 `tabLabels` 가 ' 2' · ' 3' 을 붙인다 — 이름으로 탭을 찾는 시험은 번호를 생각한다.

### 디자인 맞추기 (단계 아님)
`docs/design-gaps.md` 를 사용자가 고치는 중. 15단계 뒤 그 문서로 단계를 나눈다. 디자인 캔버스 파일은 Artifact 도구 read 로 받는다(`project/Main.dc.html` 등).

## 7. 이미 겪은 함정

- Playwright `expect.poll` 은 콜백이 throw 하면 다시 시도하지 않는다 → `?.` 로 undefined 를 돌려준다.
- Playwright 는 페이지 포커스를 흉내 내 `document.hasFocus()` 를 못 낮춘다 · 합성 키는 네이티브 메뉴 단축키를 부르지 않는다.
- 18단계부터 전체 e2e 첫 실행에서 `safety.spec.ts:48`(되살린 일감에 `echo BACK…`)이 명령 글자만 찍히고 5초 안에 출력이 없어 실패하고, 다시 돌리면 통과한다(전체 실행 4번 중 3번, 마지막 한 번은 처음부터 통과). 앞 71개만 같은 순서로 돌리면 재현 안 됨 — 원인 미확인. 19단계 전체 실행 3번 중 1번 다시 나옴: 받은 화면이 `echo BACK$((1+1)) ` 뿐 — **프롬프트가 한 번도 안 그려졌다**(입력은 tty 가 되돌린 글자). 시험은 프롬프트를 기다리지 않고 친다. 지킴이 `spawn` 은 같은 paneId 의 끝나지 않은 세션이 있으면 그 세션에 붙는다(`host-core.ts` spawn 의 `old && !old.exited`) — 지운 B 의 셸(SIGHUP · 2초 뒤 SIGKILL)과 되살린 B 가 같은 `p2` 를 쓰므로 후보지만, 지우기 → 되살리기 사이가 몇 초라 확인 못 함. 다음에 볼 것: 실패 때 지킴이 `list` 로 p2 세션의 pid · killed · 시작 시각을 남기기.
- 22단계 전체 검사에서 한 번씩 불안정: `safety.spec` '일감 지우기 → … 되살리기' 의 셸 출력 기다림 · `sidebar-flow.spec` 의 afterEach `rmSync` ENOTEMPTY. 다시 돌리면 통과 — 되풀이되면 그 시험의 기다림 · 정리를 고친다.
- 23단계 리뷰 뒤 전체 검사에서 한 번씩 불안정(처음 나옴): `persist.spec:93` ⌥⌘Q 묻기 전에 셸 자식 pid 하나가 이미 죽어 있음 · `ports.spec:56` python 서버 칩이 15초 안에 안 뜸. 다시 돌리면 통과 — 되풀이되면 그 시험의 기다림을 고친다.
- 24단계 전체 검사에서 한 번(처음 나옴): `restore.spec:70` 이 되살린 pane 에 `echo "PWD=$PWD"` 를 쳤는데 앞 `echo "` 가 사라지고 `PWD=$PWD"` 만 들어가 `dquote>` 에 멈춤 — '이전 세션' 구분 줄이 그려진 직후였다. BACK2 · tabs:175 와 같은 '친 글자가 셸에 안 닿음' 무리(앞부분만 잃음). 같은 단계 첫 전체 검사에서는 `history.spec:201` afterEach `rmSync` ENOTEMPTY(sidebar-flow 와 같은 정리 문제) · `tabs.spec:231`(마지막 탭 닫고 새 탭 셸) 이 한 번씩 — 다시 돌리면 통과. 같은 검사 다음 판에 `find.spec:26`(`for` 가 사라짐) · `ports.spec:110/123`(서버 명령이 안 돌아 칩 없음)도 나와 원인을 봤다: **main 의 `PtyManager.write` 는 spawn · attach 답을 받아 주인을 정하기 전의 키를 조용히 버린다**(`owned()`), 시험은 프롬프트를 기다리지 않고 클릭 뒤 바로 친다. → `TerminalPane` 이 붙기 전에 친 키를 모아 두었다가 spawn · attach 가 끝나면 보낸다(상한 64KB, 24단계). 경합이라 정해진 재현 시험은 없다 — 고친 뒤 그 시험들을 3번씩 돌리고 전체 검사로 확인했다(결과는 `docs/stages/24-cli-resume.md`).
- e2e 전체 실행에서 가끔 앱 창이 안 뜬다(원인 미확인, `test-results/launch-hangs/log.txt` 에 쌓임) → full-check 가 다시 돌려 '불안정(3)' 으로 나눈다. 보고에 적는다.
- e2e `win.evaluate` 안에서는 `window` 대신 `globalThis`(tsconfig.node 에 DOM 이 없다).
- 변이 목록의 `\n` 은 줄바꿈 — 코드의 글자 그대로 `\n` 은 `\\n`.
- python 등으로 파일을 고치면 편집 훅(tsc)이 돌지 않는다 → 고친 뒤 `npm run typecheck`.
- 열린 대화상자 · `then` 이 가리키는 대상이 그 사이 사라질 수 있다 — 저장할 내용은 연 순간에 떠 두고, 지울 대상은 id 로 다시 찾는다(12단계 리뷰).

## 8. 1차 출시까지 남은 것 (25단계 끝에 모음)

0~25단계 기능은 모두 `main` 에 있다. 아래는 **사용자 손이 필요한 것 · 실제 환경에서만 확인되는 것** 이다. 하나씩 끝나면 이 절에서 지운다.

### 사용자 준비물 → 출시
1. **Developer ID 서명 · 공증** — 키체인에 'Developer ID Application' 인증서(Xcode › Settings › Accounts › Manage Certificates) + 공증 프로필 `taskminal-notary`(`xcrun notarytool store-credentials taskminal-notary --apple-id … --team-id …`, 비밀번호는 앱 전용 암호를 사용자가 직접). 그 뒤 `npm run release` — 서명 · 공증 · `spctl -a` · 배포본 검사(`scripts/check-package.mjs`)까지 한 번에. 둘 중 하나라도 없으면 release 가 무엇이 없는지 말하고 멈춘다(`scripts/release-config.mjs`).
2. **GitHub Releases 올리기** — 업데이트 주소는 `petercorders/taskminal`(18단계). 저장소 push · 릴리스 만들기는 메인 세션(사용자 확인) 몫.
3. **/Applications 설치 · Finder 더블클릭 실행** — 개발 앱이 아니라 서명된 .app 으로(14 · 18단계 미확인). 확인할 것: 셸 · 한글 · 최소 환경 PATH(`which node`) · 셸 지킴이 · 0.1.0 → 0.1.1 자동 업데이트 뒤 셸 유지(18단계 verify 중 실제 설치 성공).
4. **명령줄 도구 설치** — 앱 메뉴 '명령줄 도구 설치…' 가 `/usr/local/bin/taskminal` 링크를 만든다. 쓸 수 없는 폴더면 직접 칠 `sudo mkdir … && sudo ln -sf …` 명령을 돌려준다(`src/main/cli-install.ts`) — 서명된 .app 에서 실제 설치는 미확인(24단계).

### 미확인 (실제 환경 · 계정이 있어야 함)
| 무엇 | 왜 못 봤나 | 확인 방법 |
|---|---|---|
| Synology(NAS) 의 tmux · 기본 셸 · ControlMaster | 실제 NAS 접속 금지(25단계 지시) | 원격 일감 하나 → `tm-<pane>` 세션에 붙는지 · tmux 가 없으면 로그인 셸로 뜨는지 · 끊었다 다시 붙기 |
| Finder 로 띄운 앱의 ssh-agent | 스파이크로 `launchctl getenv SSH_AUTH_SOCK` 가 launchd 소켓을 돌려줌을 봄 — 실제 원격 접속은 안 함 | 서명된 앱을 Finder 로 열고 원격 일감 연결(키 인증) |
| 새 일감 호스트 칸의 ↑↓ 제안(`<datalist>`) | 시험은 option 값만 봄 | ~/.ssh/config 가 있는 Mac 에서 ↑↓ 로 고르기 |
| 원격 일감에서 대화(⇧⌘J) · 변경 검토 | 막지 않음 — 이 Mac 에서 원격 경로로 돈다(25단계 알려진 한계) | 필요하면 원격 일감에서 두 메뉴를 끄는 작은 단계 |
| 한글 입력기를 켠 채 ⌥1~9 · ⌥1/⌥2(새 일감) | Playwright 합성 키는 IME 상태를 흉내 못 함(20 · 25단계) | 한글 입력기 켜고 직접 눌러 보기 |
| 실제 claude 대화 · 실제 codex 승인 · 질문 · 한도 줄 | 가짜 claude · codex 로만 e2e(21 · 22단계) | 로그인한 claude · codex 로 대화 하나씩 |
| 커밋 서명(gpg · ssh 서명)이 창 없이 물을 때 | 실패 길만 시험(23단계) | 서명 설정된 저장소에서 변경 검토 › 커밋 |
| 다른 사용자가 CLI 소켓에 접근 | 같은 사용자 0600 · 폴더 0700 만 확인(24단계) | 다른 계정에서 `taskminal task list` 가 거절되는지 |
| 주간 정리의 일감별 AI 토큰 | 원천 없음(대화 `turn_end` 에 토큰 수 없음 · 터미널 claude 는 앱이 모름, 25단계 스파이크) — 칸을 뺐다 | 원천이 생기면 다시 계획 |

### 알려진 불안정
7절. 24단계 고침(붙기 전 친 키를 모아 보냄) 뒤 25단계까지의 전체 검사 결과는 25단계 결과 절(`docs/stages/25-archive-remote.md`)에 적는다.
