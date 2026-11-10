# 15b 링크 열기

## 목표
터미널 출력의 http(s) 주소 · OSC 8 링크를 **⌘+클릭**으로 기본 브라우저에서 연다.

## 결정 (추천안으로 정함)
| 무엇 | 결정 | 이유 |
|---|---|---|
| 여는 동작 | ⌘+클릭만 (그냥 클릭은 글 선택) | iTerm2 · Terminal · VS Code 터미널과 같다. 그냥 클릭으로 열면 선택하다 실수로 열린다 |
| 찾는 방법 | `@xterm/addon-web-links` 0.12(글 속 주소) + xterm `linkHandler`(OSC 8 링크) — 같은 처리 함수 | 둘 다 xterm 공식 |
| 여는 곳 | renderer → `app:openLink`(send) → main `openExternalIfWeb` (http · https 만, 우리 창에서 온 것만) | renderer 는 `shell` 이 없다. `window.open` 길(setWindowOpenHandler)도 같은 검사지만, 의도가 분명한 좁은 API 로 |
| 거르기 | 순수 함수 `linkToOpen(uri, metaKey)` (src/shared/links.ts) — ⌘ 없거나 http(s) 아니면 null. main 도 `webUrl` 로 다시 거른다 | renderer 를 믿지 않는다 |
| file:// · ssh:// · 다른 앱 주소 | 열지 않음 | 터미널 출력은 남이 만든 글 — 다른 앱을 부르는 주소는 위험 |
| 마우스를 올렸을 때 | xterm 기본(밑줄 · 손가락) — 안내 글은 띄우지 않음 | 디자인에 없음 |

디자인: 캔버스(메인 · 설정)에 링크 관련 요소 없음 → 옮겨 적을 디자인 요소 없음.

## 바꿀 곳
- `src/shared/links.ts` 새: `webUrl(url): string | null`(http · https 만, 파싱 실패 null) · `linkToOpen(uri, metaKey)`
- `src/shared/ipc.ts` `openLink: 'app:openLink'` · preload `openLink(url)` · api.d.ts
- `src/main/index.ts` `openExternalIfWeb` 가 `webUrl` 을 쓰게 · `ipcMain.on(IPC.openLink)` (fromOurWindow · 글자 · 길이 2048 이하)
- `src/renderer/TerminalPane.tsx` WebLinksAddon(handler) · Terminal 옵션 `linkHandler: { activate, allowNonHttpProtocols: false }`

## 종료 경로 · 데이터
저장하는 것 없음. 잘못된 주소는 조용히 무시.

## 시험
- 단위 `tests/unit/links.test.ts`: http · https 통과, ⌘ 없음 · file: · javascript: · ssh: · 깨진 글 · 빈 글 → null, 대문자 스킴(HTTPS://) 통과
- e2e(작성만 · 미실행): `tests/e2e/links.spec.ts` — `echo https://example.com/x` 출력 위를 ⌘+클릭 → main 의 가짜 openExternal 에 기록, 그냥 클릭은 기록 없음, OSC 8 링크도 ⌘+클릭으로 열림
- 변이: links.ts 의 ⌘ 검사 · 프로토콜 검사

e2e 미실행(사용자 지시 2026-11-10) — 돌려야 할 목록: `tests/e2e/links.spec.ts` 3개
