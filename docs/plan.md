# Taskminal — 단계 계획

일감(작업 단위)별로 터미널 세션을 묶어 쓰는 macOS 터미널. 매일 쓰는 도구가 목표 (2026-11-10 결정).
진행: 단계마다 `/harness-run electron N단계` → 계획 → 구현 · 검증 → 커밋, 끝나면 `/harness-gc electron retro`.

## 정해진 것
- 스택: Electron 45 + electron-vite 6 + React 19 + TypeScript 5.9, 터미널 = xterm.js 6 + node-pty 1.1 (Orca · VS Code 와 같은 조합 — 한글 IME · TUI 호환이 가장 검증됨)
- v1 범위: 일감 템플릿 · 상태/색/묶음 커스텀 · 재시작 복원. git worktree 자동 생성은 v1 밖.
- 일감 = 이름 · 작업 폴더 · 상태 · 색 · 묶음 · 탭들(탭마다 분할 트리). 일감을 바꿔도 다른 일감의 터미널은 뒤에서 계속 돈다.
- 복원 때 실행 중이던 명령(`flutter run` 등)은 다시 돌리지 않는다 — 시작 명령은 일감을 만들 때 한 번만 (`pendingCommand`).
- 렌더러는 xterm DOM 렌더러로 시작 (WebGL 컨텍스트는 창당 ~16개 한도라 일감이 많으면 깨진다 → 15단계에서 보이는 것만 WebGL).
- e2e 는 `TASKMINAL_USER_DATA` 임시 폴더만 쓴다 — 실제 사용자 데이터를 건드리지 않는다.
- node-pty 1.1.0 npm 패키지는 `spawn-helper` 실행 권한이 빠져 있다 → `scripts/fix-node-pty.mjs` (postinstall).

## 디자인 (2026-11-10, Claude 디자인 캔버스)
https://claude.ai/artifact/RrUwTt7trhmpxBrXuXEp7d — 메인 창 · 새 일감 · 설정 창(6칸) · 명령 팔레트 4장. 화면을 만드는 단계(5~12)는 이 캔버스를 기준으로 한다.
- 어두운 바탕(#0e0f11) · 강조 파랑(#5b9cf5) · Inter + Noto Sans KR / 터미널 JetBrains Mono
- **상태 두 가지를 섞지 않는다**: 사용자가 정하는 '상태'(진행 중 · 대기 …)는 둘째 줄 글자, 터미널이 알려 주는 '활동'(실행 중 · 입력 기다림 · 끝남 · 실패)은 오른쪽 아이콘. 활동 아이콘은 색만이 아니라 모양(호 · 원 · 체크 · 네모)으로도 구분
- 사이드바: 맨 위 '확인 필요'(입력 기다림 · 실패한 일감만, ⌘⇧A 다음) → 묶음별 일감(두 줄: 이름 / 브랜치·폴더 + 상태) → 접힌 '완료' → 범례 · 설정
- 본문: 일감 머리(이름 · 폴더 · "터미널 3 · 1개 실행 중" · 상태 칩 · 묶음 칩) → 탭 줄(실행 중 표시 · "+ ▾" 로 템플릿 탭) → 분할 pane
- pane 머리: 명령 · 폴더 · 실행 상태(● 실행 중 · 경과 / ✓ exit 0 · 걸린 시간 / ✗ exit 1). 포커스 pane 은 머리 아래 강조색 줄, 나머지 pane 은 내용을 흐리게(기본 0.62)
- 새 일감: 이름 · 폴더(최근 폴더) · 템플릿 카드(분할 미리보기 + 명령) · 상태 · 묶음 · 색, "시작 명령은 한 번만" 안내
- 설정 창: 일반 · 모양 · 터미널 · 알림 · 활동 · 단축키 · 일감 관리(상태 · 묶음 · 템플릿) 6칸, 바꾸면 바로 저장. 알림은 '언제 × macOS 알림/소리' 표, 단축키는 겹침을 빨갛게
- 명령 팔레트(⌘P): 일감 · 템플릿 · 명령 · 터미널 출력을 한 번에 찾음, ⌘↩ 새 탭으로, 맞는 게 없으면 그 이름으로 새 일감

참고한 것 (2026-11-10 조사)
- Orca: 작업 카드마다 에이전트 상태 점(작업 중 노랑 · 끝남 초록)과 '방금' 시각, 권한 · 질문을 기다리는 에이전트를 모은 'Needs You' 칸 — https://www.onorca.dev/changelog/1-3-41 · https://www.onorca.dev/docs/model/agents-sessions
- Warp: 세로 탭 사이드바, Tab Configs(폴더 · 시작 명령 · pane 배치를 저장, "+" 메뉴에서 열기, 탭 우클릭 "Save as new config") — https://docs.warp.dev/terminal/windows/vertical-tabs · https://docs.warp.dev/terminal/windows/tab-configs
- Ghostty: `unfocused-split-opacity` 로 포커스 아닌 분할을 흐리게 — https://www.mintlify.com/ghostty-org/ghostty/features/splits-tabs
- Superset: 에이전트 래퍼가 알림을 보내 사이드바에서 여러 작업 공간을 지켜봄 — https://docs.superset.sh/agent-integration

## 단계

| # | 단계 | 범위 | verify |
|---|---|---|---|
| 0 | 뼈대 · 하네스 | package.json · tsconfig(node/web) · vitest · 전역 electron 하네스 · 이 문서 | 편집 · 종료 훅이 경계 · 타입 · 시험 실패를 막는 것을 일부러 깨서 확인 (완료) |
| 1 | 공통 모델 | `src/shared`: 타입 · 분할 트리(split/remove/ratio/cycle) · 일감 만들기 · 템플릿 펼치기 · 저장 파일 검증(normalize) · 기본 상태/템플릿 | vitest 단위 시험 + 핵심 줄 변이 확인 |
| 2 | Electron 창 | electron-vite 설정 · main 창(sandbox · contextIsolation) · preload API 골격 · React 빈 화면 · Playwright e2e 골격 | `npm run e2e` 가 창을 띄워 제목 확인 + 스크린샷 (완료: 제목 · preload 왕복 · 실제 샌드박스 · 임시 userData · 바깥 링크 차단) |
| 3 | 터미널 하나 | main PtyManager(spawn · write · resize · kill · 출력 묶어 보내기) · xterm pane · 로그인 셸 · LANG/TERM 환경 · 종료 경로 4개(창 닫기 · 앱 종료 · 새로 고침 · 렌더러 충돌)에서 pty 정리 | e2e: `echo 안녕` 출력 · `stty size` 가 창 크기와 맞음 · 앱 종료 후 고아 셸 0개(`pgrep`) (완료: 종료 경로 4개마다 셸 · 백그라운드 자식 pid 가 사라짐. 남은 것: 한글 글꼴 — Menlo 에 한글이 없어 글자 간격이 벌어짐 → 8단계 한글 입력 때 한글 포함 고정폭 글꼴 대체 목록) |
| 4 | 상태 저장 | main: state.json 원자적 저장 · 손상 파일 백업 후 기본값 · `TASKMINAL_USER_DATA` · renderer 상태 저장소(reducer) · 변경 시 디바운스 저장 · **더 새 버전 파일(version > 1)은 덮어쓰지 않는다**(1단계 리뷰: normalizeState 는 모르는 칸을 버리므로 옛 앱이 새 파일을 저장하면 데이터가 사라짐 → 읽기 전용으로 열고 알리거나 백업 후 진행) | 단위(reducer · normalize) + e2e: 손상 파일로 시작해도 뜨고 `.bak` 남음 · version 2 파일로 시작하면 원본이 그대로 (완료: + 종료 직전 저장 · 새로 고침 뒤 유지) |
| 5 | 일감 사이드바 | 일감 목록 · 새 일감 대화상자(이름 · 폴더 선택 · 상태 · 묶음 · 색) · 전환 시 터미널 유지 · 일감 삭제(확인) | e2e: 일감 2개 만들고 오가도 각 셸 출력 유지 · 삭제 시 그 pty 종료 (완료: + 확인 취소 · 폴더 선택 · 재시작 유지 · 빈 화면. 묶음 만들기는 11단계 — 그 전엔 저장 파일로만) |
| 6 | 탭 | 탭 바 · 새 탭 · 닫기 · 전환 · 탭 이름 바꾸기 | e2e: 탭 3개 · 가운데 닫기 · 활성 탭 이동 규칙 (완료: + 닫은 탭의 셸만 끝남 · 더블클릭/F2 이름 바꾸기 · 재시작 유지 · 탭도 처음 볼 때 셸 · 마지막 탭을 닫아도 일감은 남음) |
| 7 | 분할 | 오른쪽/아래 분할 · 드래그로 비율 · pane 포커스 이동 · 셸 `exit` 시 pane 닫힘 · 마지막 pane 닫으면 탭 닫힘 | 단위(트리) + e2e: 분할 후 각 pane 의 `stty size` 가 실제 크기와 맞음 (완료: pane 은 layoutRects 로 평평하게 그려 분할해도 화면 유지 · 끌기/키보드 비율 · 클릭으로 활성 pane · exit 로 닫힘 · 새로 고침 · 재시작 유지. 분할 버튼은 탭 줄 오른쪽, 단축키는 8단계) |
| 8 | 메뉴 · 단축키 | 앱 메뉴(iTerm 방식 ⌘T · ⌘D · ⇧⌘D · ⌘W · ⌘1~9 · ⇧⌘[ ] · ⌘[ ] · ⌘K · ⌘+/−) · 복사/붙여넣기 · 한글 조합 입력 | e2e: 단축키별 결과 · 한글 입력이 셸에 그대로 · 붙여넣기 (완료: 단축키는 renderer 가 키 표 하나(`src/shared/keymap.ts`)로 물리 키(code) 기준 처리 — 한글 입력 상태의 ⌘T 도 됨, 메뉴는 같은 표로 표시만(registerAccelerator:false)하고 누르면 같은 명령 · ⌘1~8 n번째 탭 · ⌘9 마지막 탭 · ⌥⌘↑↓ 일감 · ⌘N 새 일감 · 대화상자가 열리면 무시 · ⌘W 키 반복 무시 · 기본 메뉴의 ⌘R 새로 고침(셸 전부 종료) 없앰 · 복사/붙여넣기는 네이티브 role · 글꼴 크기 저장. 한글 글꼴은 설치된 D2Coding 이 있으면 그것, 없으면 Apple SD Gothic Neo — 한글 칸 사이 틈은 Terminal.app 수준으로 남음. 실제 macOS 한글 입력기로 친 확인은 미확인(CDP 조합 흉내로만)) |
| 9 | 활동 · 확인 필요 | 셸 통합(zsh 에 OSC 133 프롬프트 · 명령 시작/끝 표시를 넣는 시작 스크립트, 사용자 .zshrc 는 그대로 읽음)으로 pane 마다 실행 중 · exit 코드 · 걸린 시간 / 벨 · OSC 9 · 777 알림 → '입력 기다림' / 일감 활동 = pane 들의 합 / 사이드바 아이콘 · '확인 필요' · ⌘⇧A · 탭 실행 표시 · pane 머리 / 포커스 아닌 pane 흐리게 | 단위(OSC 해석 · 합치기 규칙) + e2e: `sleep 1; false` → 실패 표시와 exit 1, `printf '\a'` → 확인 필요에 뜨고 그 pane 을 보면 사라짐. **확인할 것**: Claude Code 가 입력을 기다릴 때 실제로 내보내는 신호(벨/OSC 9)를 이 앱 안에서 측정 (완료: zsh 통합 `resources/shell/zsh`(ZDOTDIR 감싸기 — 사용자 설정 그대로 읽고 끝나면 ZDOTDIR 원래대로) · OSC 133 + 명령 글자 OSC 6973 · pane 머리 · 사이드바 '확인 필요' · ⇧⌘A · 탭 표시 · 분할 흐림 0.62 · 실행 중 pane/탭 닫기 확인 · 일감 지우기 문구에 실행 중 수. Claude Code 신호는 공식 문서 기준(측정 아님): 기본 `auto` 는 Taskminal 에서 **아무것도 내지 않는다** → `preferredNotifChannel: "terminal_bell"` 이나 Notification 훅(OSC 9 · 777 · BEL)을 쓰면 앱이 받는다. 남은 것: 패키징 때 셸 통합 폴더를 asar 밖으로(14) · bash/fish 통합 없음 · 창이 포커스를 잃은 동안의 벨 → 확인 필요는 시험하지 못함(Playwright 가 포커스를 흉내 내 App 의 창 포커스 판정을 못 낮춤 — 규칙 자체는 단위 시험)) |
| 10 | 명령 팔레트 | ⌘P: 일감 · 템플릿 · 명령 · 터미널 출력(각 pane 스크롤 버퍼) 찾기, ↑↓ · ↩ · ⌘↩ 새 탭 · ⇥ 범위, 없으면 새 일감 | 단위(찾기 · 순위) + e2e: 키보드만으로 일감 이동 · 출력 찾기 결과에서 그 pane 으로 이동 (완료: `src/shared/palette.ts` 순위(앞부분 > 낱말 시작 > 중간 > 글자 순서) · 출력은 2글자부터 최대 20줄(셸이 떠 있는 pane 만, 숨은 pane 포함) · 템플릿 → 그 템플릿으로 새 일감 대화상자 · 없으면 그 이름으로 새 일감 · ⌘↩ 는 일감에만(새 탭) · 조합 중 ↩ 무시. 남은 것: 최근 사용 순위 · 초성 찾기 · 한글이 든 줄의 선택 위치는 글자 수 기준이라 넓은 글자만큼 어긋날 수 있음) |
| 11 | 설정 창 | 왼쪽 메뉴 6칸 · 바꾸면 바로 저장 · 설정 찾기. **일반**(앱을 열 때: 되살리기/목록만/빈 창 · 새 일감 기본 폴더 · 기본 템플릿 · 실행 중이면 끄기 전 확인 · Dock 배지 · 메뉴 막대) / **모양**(테마 어둡게·밝게·시스템 · 강조색 · 터미널 글꼴·크기·줄 간격 + 미리보기 · 분할 흐림 · 사이드바 밀도) / **터미널**(셸 · 스크롤 줄 수 · 커서 · 셸 통합 · 스크롤 되살리기 · Option=Meta · 선택 복사) / **알림 · 활동**(입력 기다림 · 오래 걸린 명령 · 실패 · 셸 닫힘 × macOS 알림·소리, 기준 시간, 보고 있는 일감은 안 알림) / **단축키**(바꾸기 · 겹침 경고 · iTerm2 기본값) / **일감 관리**(상태 · 묶음 · 템플릿) · 일감 우클릭 메뉴 · 사이드바 묶음 접기 | 단위(설정 검증 · 상태 삭제 시 일감 이동 · 단축키 겹침 찾기) + e2e: 설정마다 바꾸면 화면에 바로 반영되고 재시작 후 유지 · 겹치는 단축키 경고 |
| 12 | 템플릿 | 템플릿으로 일감 만들기(탭 · 분할 · 시작 명령 1회) · 탭 "+ ▾" 로 템플릿 탭 · "이 일감/탭을 템플릿으로 저장" · 템플릿 JSON 편집(줄 단위 검증 오류) · 기본 템플릿 2~3개 | 단위(펼치기 · 저장) + e2e: 템플릿 일감의 각 pane 에서 시작 명령이 한 번만 돈 흔적 |
| 13 | 재시작 복원 | 작업 폴더 추적(OSC 7 또는 `lsof -d cwd`) · 스크롤 내용 저장(SerializeAddon, pane 당 상한) · 종료 시 flush(before-quit) · 주기 저장 · 복원 시 명령 재실행 안 함 | e2e: `cd /tmp` 후 앱 재시작 → 같은 폴더 · 이전 출력 보임 · 시작 명령 재실행 없음 |
| 14 | 패키징 · 설치 | electron-builder .app(arm64) · asarUnpack(node-pty) · 앱 아이콘 · /Applications 설치 · Finder 실행 시 PATH/LANG | 설치한 .app 을 Finder 에서 실행해 셸 · `which node` · 한글 확인 |
| 15 | 다듬기 (v1 뒤 후보) | 보이는 pane 만 WebGL · ⌘F 검색 · 명령 끝 macOS 알림 · git worktree 일감 · 링크 열기 · 일감 브랜치 표시 | 단계마다 따로 계획 |
## 단계 사이 규칙
- 단계 하나 = 커밋 하나 이상, 단계 끝에 `npm run typecheck && npx vitest run && npm run e2e` 를 한 번에.
- 화면이 바뀐 단계는 e2e 스크린샷을 직접 열어 본다.
- GitHub 원격 저장소는 아직 없다(만들지 · push 할지는 사용자 결정).
