# 15d ⌘F 터미널 안 찾기

## 목표
⌘F 로 보고 있는 pane 의 스크롤 버퍼에서 글을 찾는다 — 맞은 곳 모두 칠하고, ↩ / ⇧↩ 로 다음 · 이전, 몇 번째인지 보인다. Esc 로 닫으면 칠한 것이 지워지고 터미널로 포커스가 돌아간다.

## 디자인에서 옮긴 것
- 단축키: 설정 보드(`project/Settings.dc.html`) 단축키 표 '터미널' 묶음에 `찾기 ⌘F` (화면 지우기 ⌘K 와 같은 묶음) → 메뉴 '편집' 의 '화면 지우기' 옆, 바꿀 수 있는 단축키 표에 `find` · `Command+F` · '찾기'
- 찾기 막대 자체의 디자인은 없음 → 팔레트 보드(`project/Palette.dc.html`)의 말을 빌린다: 어두운 판(`var(--panel)`) · 1px 선(`var(--line)`) · 둥근 모서리 · 돋보기 아이콘 · 고정폭 `esc` 칩 · placeholder 문구 톤

일부러 다르게 한 것: 팔레트는 화면 가운데 큰 창(640px · 52px 높이)이지만, 찾기는 출력을 가리지 않게 pane 오른쪽 위 작은 막대(너비 320px · 높이 32px) — 디자인 없음, VS Code · iTerm2 의 찾기 막대 자리.

## 결정 (추천안으로 정함)
| 무엇 | 결정 | 이유 |
|---|---|---|
| 찾는 곳 | `@xterm/addon-search` 0.16(15b 에 설치) — 스크롤 버퍼 전체, 접힌 줄 이어서 | xterm 공식 · 칠하기(decorations) · 결과 수 이벤트 |
| 대소문자 | 무시(고정) | 터미널 찾기의 흔한 기본. 정규식 · 단어 단위 단추는 넣지 않음 |
| 입력하는 동안 | 바로 찾음(incremental) | |
| 키 | ↩ 다음 · ⇧↩ 이전 · Esc 닫기 · 한글 조합 중 ↩ 는 글자 확정(찾지 않음) | 다른 입력칸(사이드바 이름 바꾸기)과 같은 조합 규칙 |
| 열린 채 ⌘F | 입력칸으로 포커스 · 글 전체 선택 | 브라우저 · VS Code 와 같다 |
| 몇 번째 | `3/12` · 맞은 것 없음 `없음` · 빈 입력이면 숨김 · addon 상한(1000) 넘으면 `1000+` | |
| 칠하는 색 | 맞은 곳 `#4a3f1f` · 지금 것 `#a8741a` (addon 은 #RRGGBB 만) · 스크롤 막대 표시 `#e5a54b` / `#f0b866` | 디자인의 '입력 기다림' 노랑 계열 |
| 어느 pane | 명령을 부를 때 포커스된 pane 하나(앱 전체에 막대 하나) | |
| 닫힐 때 | 칠한 것 지움 · 선택 지움 · 터미널 포커스 | |
| pane 이 사라지면 | 막대도 사라짐(그 pane 자리에만 그린다) | |

## 바꿀 곳
- `src/shared/keymap.ts` SHORTCUTS 에 `find` · `src/main/menu.ts` 편집 메뉴
- `src/shared/find.ts` 새: `findCountLabel(query, index, count)` · `findKeyAction(key, shift, composing)`
- `src/renderer/terminals.ts` TerminalHandle 에 `find: { next(q), prev(q), clear(), onResults(cb) }`
- `src/renderer/TerminalPane.tsx` SearchAddon 을 싣고 위 손잡이를 채움
- `src/renderer/FindBar.tsx` 새 · `SplitView.tsx` 가 `find.paneId === pane.id` 이면 pane 자리에 그림
- `src/renderer/App.tsx` `finding` 상태({ paneId, signal }), `case 'find'`
- `styles.css` `.find-bar`

## 종료 경로 · 데이터
저장 없음. 새로 고침 · 재시작하면 닫힌 상태.

## 시험
- 단위 `tests/unit/find.test.ts`: 숫자 표시(빈 · 없음 · n/m · 상한) · 키(↩ · ⇧↩ · Esc · 조합 중 · 다른 키)
- 단위 `tests/unit/keymap.test.ts`: `find` 가 `Command+F` 로 표에 있음(기존 겹침 · 형식 시험이 새 줄도 봄)
- e2e(작성만 · 미실행) `tests/e2e/find.spec.ts`: ⌘F → 막대 · 입력 → `1/3` → ↩ `2/3` → ⇧↩ `1/3` → Esc 닫힘 · 터미널에 다시 칠 수 있음, 없는 말 → `없음`
- 변이: find.ts 의 조합 중 · ⇧ · 상한

e2e 미실행(사용자 지시 2026-11-10) — 돌려야 할 목록: `tests/e2e/find.spec.ts` 2개 · 막대 스크린샷
