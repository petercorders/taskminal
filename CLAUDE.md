# Taskminal

일감별로 터미널 세션을 묶는 데스크톱 터미널 (macOS·Windows·Linux, Electron + xterm.js + node-pty). 단계 계획 · 결정: `docs/plan.md`

**이어서 개발할 때는 먼저 `docs/development.md` 를 읽는다** — 지금 어디까지 · 단계 하나의 순서 · 명령 · 지킬 것 · 단계별 메모 · 겪은 함정. 단계별 상세 계획은 `docs/stages/`.

## 브랜치·PR 승인 규칙 (2026-11-14 사용자 지시)

- 에이전트는 작업별 `feat/<주제>`, `fix/<주제>`, `chore/<주제>` 브랜치에서 개발하고 해당 브랜치에만 push한다. 독립 작업은 최신 `origin/main`에서 시작한다. 기존 미병합 기능이 필요한 작업은 그 기능 브랜치를 base로 하는 의존 PR로 만들고 관계를 명시한다.
- `main` 직접 push, main으로의 로컬 병합, PR merge·auto-merge·관리자 우회는 사용자가 **해당 PR과 현재 변경을 명시적으로 승인하기 전에는 금지**한다. 개발·commit·push 승인이나 과거의 포괄적인 자율 진행 지시는 main 반영 승인으로 해석하지 않는다.
- 사용자가 직접 수행하는 main 작업은 허용한다. 다른 사람의 PR은 `@petercorders`의 승인을 받는다. 에이전트는 사용자 명의의 승인 리뷰를 대신 작성하지 않는다.
- 공개 릴리스·태그 게시·공증·배포는 별도 명시적 요청이 필요하다. 현재 공개 릴리스는 보류 상태다.
- 기능 단위 PR에 목적·검증 결과·알려진 한계·의존성을 적는다. 여러 기능이 누적된 기존 브랜치는 이력을 재작성하거나 통째로 main에 합치지 말고, 사용자가 검토할 단위와 순서를 먼저 정한다.

## 진행
- 단계는 `/harness-run electron N단계` 로 진행하고 끝나면 `/harness-gc electron retro`.
- 전역 electron 하네스가 편집 · 종료 시 경계 · tsc · 관련 vitest 를 검사한다 (레퍼런스 `~/.claude/skills/harness-engineering/stacks/electron/references/`).

## 명령
- 단계 끝 검증: `bash ~/.claude/skills/harness-engineering/stacks/electron/scripts/full-check.sh` (typecheck · 경계 · vitest · e2e, 종료 코드 0 통과 · 1 실패 · 3 불안정)
- 개발 실행: `npm run dev`
- e2e 는 `TASKMINAL_USER_DATA=<임시 폴더>` 로만 앱을 띄운다 (실제 `~/Library/Application Support/Taskminal` 금지).
- e2e 는 `tests/e2e` (Playwright `_electron`), 앱은 `args: ['.']` 로 띄운다 — `out/main/index.js` 를 직접 주면 package.json 을 못 찾아 앱 이름 · 버전이 Electron 것이 된다.

## 구조
- `src/shared` 순수 로직(시험 대상) · `src/main` pty · 파일 · 메뉴 · `src/preload` 좁은 API(`api.d.ts` = renderer 가 보는 타입) · `src/renderer` React 화면
- node-pty `spawn-helper` 실행 권한은 `scripts/fix-node-pty.mjs`(postinstall)가 고친다 — 빠지면 `posix_spawnp failed`.
