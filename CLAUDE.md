# Taskminal

일감별로 터미널 세션을 묶는 macOS 터미널 (Electron + xterm.js + node-pty). 단계 계획 · 결정: `docs/plan.md`

## 진행
- 단계는 `/harness-run electron N단계` 로 진행하고 끝나면 `/harness-gc electron retro`.
- 전역 electron 하네스가 편집 · 종료 시 경계 · tsc · 관련 vitest 를 검사한다 (레퍼런스 `~/.claude/skills/harness-engineering/stacks/electron/references/`).

## 명령
- 단계 끝 검증: `npm run typecheck && npx vitest run && npm run e2e`
- 개발 실행: `npm run dev`
- e2e 는 `TASKMINAL_USER_DATA=<임시 폴더>` 로만 앱을 띄운다 (실제 `~/Library/Application Support/Taskminal` 금지).
- e2e 는 `tests/e2e` (Playwright `_electron`), 앱은 `args: ['.']` 로 띄운다 — `out/main/index.js` 를 직접 주면 package.json 을 못 찾아 앱 이름 · 버전이 Electron 것이 된다.

## 구조
- `src/shared` 순수 로직(시험 대상) · `src/main` pty · 파일 · 메뉴 · `src/preload` 좁은 API(`api.d.ts` = renderer 가 보는 타입) · `src/renderer` React 화면
- node-pty `spawn-helper` 실행 권한은 `scripts/fix-node-pty.mjs`(postinstall)가 고친다 — 빠지면 `posix_spawnp failed`.
