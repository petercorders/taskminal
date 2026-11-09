# Ilgam — 단계 계획

일감(작업 단위)별로 터미널 세션을 묶어 쓰는 macOS 터미널. 매일 쓰는 도구가 목표 (2026-11-10 결정).
진행: 단계마다 `/harness-run electron N단계` → 계획 → 구현 · 검증 → 커밋, 끝나면 `/harness-gc electron retro`.

## 정해진 것
- 스택: Electron 45 + electron-vite 6 + React 19 + TypeScript 5.9, 터미널 = xterm.js 6 + node-pty 1.1 (Orca · VS Code 와 같은 조합 — 한글 IME · TUI 호환이 가장 검증됨)
- v1 범위: 일감 템플릿 · 상태/색/묶음 커스텀 · 재시작 복원. git worktree 자동 생성은 v1 밖.
- 일감 = 이름 · 작업 폴더 · 상태 · 색 · 묶음 · 탭들(탭마다 분할 트리). 일감을 바꿔도 다른 일감의 터미널은 뒤에서 계속 돈다.
- 복원 때 실행 중이던 명령(`flutter run` 등)은 다시 돌리지 않는다 — 시작 명령은 일감을 만들 때 한 번만 (`pendingCommand`).
- 렌더러는 xterm DOM 렌더러로 시작 (WebGL 컨텍스트는 창당 ~16개 한도라 일감이 많으면 깨진다 → 13단계에서 보이는 것만 WebGL).
- e2e 는 `ILGAM_USER_DATA` 임시 폴더만 쓴다 — 실제 사용자 데이터를 건드리지 않는다.
- node-pty 1.1.0 npm 패키지는 `spawn-helper` 실행 권한이 빠져 있다 → `scripts/fix-node-pty.mjs` (postinstall).

## 단계

| # | 단계 | 범위 | verify |
|---|---|---|---|
| 0 | 뼈대 · 하네스 | package.json · tsconfig(node/web) · vitest · 전역 electron 하네스 · 이 문서 | 편집 · 종료 훅이 경계 · 타입 · 시험 실패를 막는 것을 일부러 깨서 확인 (완료) |
| 1 | 공통 모델 | `src/shared`: 타입 · 분할 트리(split/remove/ratio/cycle) · 일감 만들기 · 템플릿 펼치기 · 저장 파일 검증(normalize) · 기본 상태/템플릿 | vitest 단위 시험 + 핵심 줄 변이 확인 |
| 2 | Electron 창 | electron-vite 설정 · main 창(sandbox · contextIsolation) · preload API 골격 · React 빈 화면 · Playwright e2e 골격 | `npm run e2e` 가 창을 띄워 제목 확인 + 스크린샷 |
| 3 | 터미널 하나 | main PtyManager(spawn · write · resize · kill · 출력 묶어 보내기) · xterm pane · 로그인 셸 · LANG/TERM 환경 · 종료 경로 4개(창 닫기 · 앱 종료 · 새로 고침 · 렌더러 충돌)에서 pty 정리 | e2e: `echo 안녕` 출력 · `stty size` 가 창 크기와 맞음 · 앱 종료 후 고아 셸 0개(`pgrep`) |
| 4 | 상태 저장 | main: state.json 원자적 저장 · 손상 파일 백업 후 기본값 · `ILGAM_USER_DATA` · renderer 상태 저장소(reducer) · 변경 시 디바운스 저장 | 단위(reducer · normalize) + e2e: 손상 파일로 시작해도 뜨고 `.bak` 남음 |
| 5 | 일감 사이드바 | 일감 목록 · 새 일감 대화상자(이름 · 폴더 선택 · 상태 · 묶음 · 색) · 전환 시 터미널 유지 · 일감 삭제(확인) | e2e: 일감 2개 만들고 오가도 각 셸 출력 유지 · 삭제 시 그 pty 종료 |
| 6 | 탭 | 탭 바 · 새 탭 · 닫기 · 전환 · 탭 이름 바꾸기 | e2e: 탭 3개 · 가운데 닫기 · 활성 탭 이동 규칙 |
| 7 | 분할 | 오른쪽/아래 분할 · 드래그로 비율 · pane 포커스 이동 · 셸 `exit` 시 pane 닫힘 · 마지막 pane 닫으면 탭 닫힘 | 단위(트리) + e2e: 분할 후 각 pane 의 `stty size` 가 실제 크기와 맞음 |
| 8 | 메뉴 · 단축키 | 앱 메뉴(iTerm 방식 ⌘T · ⌘D · ⇧⌘D · ⌘W · ⌘1~9 · ⇧⌘[ ] · ⌘[ ] · ⌘K · ⌘+/−) · 복사/붙여넣기 · 한글 조합 입력 | e2e: 단축키별 결과 · 한글 입력이 셸에 그대로 · 붙여넣기 |
| 9 | 커스텀 | 설정 화면: 상태(이름 · 색 · 순서) · 묶음 · 글자 크기 · 셸 경로 / 일감 우클릭 메뉴(상태 · 묶음 · 색 · 이름 · 삭제) / 사이드바 묶음별 접기 | 단위(상태 삭제 시 일감 이동) + e2e: 새 상태를 만들어 일감에 붙이고 재시작 후 유지 |
| 10 | 템플릿 | 템플릿으로 일감 만들기(탭 · 분할 · 시작 명령 1회) · "이 일감을 템플릿으로 저장" · 템플릿 JSON 편집(검증 오류 표시) · 기본 템플릿 2~3개 | 단위(펼치기 · 저장) + e2e: 템플릿 일감의 각 pane 에서 시작 명령이 한 번만 돈 흔적 |
| 11 | 재시작 복원 | 작업 폴더 추적(`lsof -d cwd`) · 스크롤 내용 저장(SerializeAddon, pane 당 상한) · 종료 시 flush(before-quit) · 주기 저장 · 복원 시 명령 재실행 안 함 | e2e: `cd /tmp` 후 앱 재시작 → 같은 폴더 · 이전 출력 보임 · 시작 명령 재실행 없음 |
| 12 | 패키징 · 설치 | electron-builder .app(arm64) · asarUnpack(node-pty) · 앱 아이콘 · /Applications 설치 · Finder 실행 시 PATH/LANG | 설치한 .app 을 Finder 에서 실행해 셸 · `which node` · 한글 확인 |
| 13 | 다듬기 (v1 뒤 후보) | 보이는 pane 만 WebGL · ⌘F 검색 · 명령 끝 알림 · git worktree 일감 · 링크 열기 | 단계마다 따로 계획 |

## 단계 사이 규칙
- 단계 하나 = 커밋 하나 이상, 단계 끝에 `npm run typecheck && npx vitest run && npm run e2e` 를 한 번에.
- 화면이 바뀐 단계는 e2e 스크린샷을 직접 열어 본다.
- GitHub 원격 저장소는 아직 없다(만들지 · push 할지는 사용자 결정).
