# 15e 보이는 pane 만 WebGL

## 목표
보이는 pane 은 WebGL 로 그려 출력이 많을 때(빌드 로그 · `cat` 큰 파일) 빠르게, 숨은 pane(다른 탭 · 다른 일감)은 WebGL 을 놓아 창당 WebGL 컨텍스트 한도(Chromium ~16)를 넘지 않게 한다. WebGL 이 안 되거나 컨텍스트를 잃으면 지금의 DOM 그리기로 돌아간다.

## 디자인
설정 보드에 그리기 방식 · GPU 설정 없음 → 설정을 더하지 않는다(사용자에게 보이는 변화 없음). 옮겨 적을 디자인 요소 없음.

## 결정 (추천안으로 정함)
| 무엇 | 결정 | 이유 |
|---|---|---|
| 언제 WebGL | pane 이 보일 때(일감 · 탭이 보임) 싣고, 숨으면 `dispose` | plan.md 1절: 컨텍스트 한도 |
| 한 창에서 동시에 | 최대 8개 (`MAX_WEBGL`) — 넘으면 그 pane 은 DOM | 분할 많이 해도 한도(16)의 절반 |
| 실패 | 만들다 던짐 · `onContextLoss` → 그 pane 은 DOM 으로, 실패 2번이면 이번 실행에서는 그 pane 에 다시 시도 안 함 | GPU 문제에서 되풀이 · 깜빡임 막기 |
| e2e | 시험은 DOM(`.xterm-rows` 글을 읽음) — `TASKMINAL_RENDERER=dom` 을 playwright 설정이 기본으로 넣고, WebGL 시험만 `webgl` | 기존 e2e 의 글 읽기가 깨지지 않게 |
| 앱이 아는 법 | main 의 `appInfo.renderer`(`'webgl'` 기본 · 환경 변수 `dom`) → `runtime.renderer` | 13단계 cwdPollMs 와 같은 길 |
| 보이는지 | SplitView 의 `visible`(일감 · 탭이 모두 보임)을 TerminalPane 에 `visible` 로 | 이미 있는 값 |
| 확인용 표시 | 터미널 host 에 `data-renderer="webgl" \| "dom"` | e2e · 디버깅 |

## 바꿀 곳
- `src/shared/renderer.ts` 새: `MAX_WEBGL` · `MAX_WEBGL_FAILURES` · `wantWebgl({ mode, visible, inUse, failures })`
- `src/shared/ipc.ts` AppInfo `renderer` · `src/main/index.ts` 환경 변수 → appInfo · `src/renderer/runtime.ts` · `App.tsx`(appInfo 받을 때)
- `src/renderer/TerminalPane.tsx` `visible` prop · effect([visible]) 에서 싣기 · 놓기 · 실패 세기 · `data-renderer`
- `src/renderer/SplitView.tsx` `visible` 넘김
- `playwright.config.ts` `process.env.TASKMINAL_RENDERER ??= 'dom'`

## 종료 경로 · 데이터
저장 없음. pane 이 사라지면(term.dispose) addon 도 같이 정리 — 세는 수도 줄인다.

## 시험
- 단위 `tests/unit/renderer.test.ts`: 숨음 → 아니오 · dom 모드 → 아니오 · 상한 · 실패 2번 · 보이고 여유 있으면 예
- e2e(작성만 · 미실행) `tests/e2e/webgl.spec.ts`(`TASKMINAL_RENDERER=webgl`): 보이는 pane `data-renderer=webgl` + canvas · 다른 탭으로 가면 그 pane 은 `dom` · 돌아오면 `webgl` · 분할 9개면 9번째는 `dom`
- 변이: renderer.ts 의 각 조건

e2e 미실행(사용자 지시 2026-11-10) — 돌려야 할 목록: `tests/e2e/webgl.spec.ts` 2개 + **기존 e2e 전체**(playwright 설정 기본값이 바뀜)
