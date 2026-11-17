# 59 — AI 도구(Claude · Codex)에 실제 로고

사용자 2026-11-18 "claude나 codex이런 ai 툴전부 실제 아이콘들을 넣어줘". base `origin/main` 4ae00e8, 브랜치 `feat/59-agent-icons`.
자율 진행 지시대로 계획 파일로 승인을 대신했다(plan-check 의 요청 칸 ①~④ 는 요청이 없는 표시 변경이라 해당 없음 — 문장으로 맞추지 않았다).
**e2e 는 돌리지도 새로 쓰지도 않았고 앱도 띄우지 않았다**(사용자 지시가 이어진다). 구현은 worker 하나가 따로 worktree 에서, 고지 · 리뷰 고침 · 문서는 부모가 했다.

## 무엇을 바꿨나
- 앱이 다루는 AI 도구는 Claude · Codex 둘이다. 이름 글자만 있던 자리에 로고를 **이름 앞에** 더했다 — 글자는 그대로다.
- 로고 원본: Claude = simple-icons 16.38.0 `claude.svg`(CC0-1.0, 채움 `#D97757`) · Codex = `@lobehub/icons-static-svg` 1.103.0 `codex.svg`(MIT, 글자색). path 의 `d` 만 `src/shared/agent-icons.ts` 에 옮겼고(원본과 길이 · sha256 이 같은지 단위 시험이 지킨다) `src/renderer/AgentIcon.ts` 가 그린다.
- 고지: `THIRD_PARTY_NOTICES.md`(원본 · 라이선스 · lobe-icons MIT 전문 · 로고는 Anthropic · OpenAI 의 상표). 앱 묶음의 Resources 에 같이 넣고 `check-package` 가 본다.

| 넣은 자리 | 파일 |
|---|---|
| 대화 탭 이름 앞(이름을 바꾼 탭 포함) · 대화가 없으면 활성 pane 의 터미널에서 도는 에이전트 | `TabBar.tsx` |
| 대화 pane 머리 배지 · 터미널 pane 머리의 에이전트 상태 | `ChatPane.tsx` · `activity-ui.tsx` |
| 사이드바 둘째 줄의 에이전트 상태 · 전체 보기 카드와 pane 줄 | `Sidebar.tsx` · `Overview.tsx` |
| 새 일감 '시작' 고르기 · 설정 › 새 일감 시작 · 탭 ▾ 새 대화 | `NewTaskDialog.tsx` · `SettingsView.tsx` · `TemplateMenu.tsx` |
| 에이전트 세션 줄 · 대화 기록 찾기 결과 · 사용량·계정의 계정 표시 · 원격 패널의 새 대화 단추 | `AgentSessionsPanel.tsx` · `ConversationSearch.tsx` · `AccountsPanel.tsx` · `RemotePanel.tsx` |

넣지 않은 자리: 문장 속의 이름(안내 · 설명 · 처음 실행) · `<option>` 안 · 글자만 받는 공용 메뉴(⌘P · PopupMenu · 앱 메뉴) · 사이드바 한도 막대의 `Claude`(폭이 빠듯해 값 글자와 겹칠 것으로 추정 — 화면 확인 없이 넣지 않음).

## 검증
- typecheck · 경계 통과 · 단위 1,469 통과(58 뒤 1,452 → +17). **e2e 미실행.**
- 변이 18개 모두 잡음(아이콘 · 데이터 · 탭/사이드바/전체 보기의 에이전트 판정 16 · 고지 파일 검사 2).
- 코드 리뷰(/code-review medium, 읽기 · 단위만): 9건 — 고침 3(터미널에서 도는 에이전트 탭에 로고가 없음 · 메뉴의 강조색 바탕에서 Claude 주황이 묻힘 · 고지가 asar 안에만 있어 읽을 수 없음), 남김 6(이름 고치는 중 탭 로고가 사라짐 · 대화 둘인 탭에서 포커스가 셸이면 첫 대화의 로고 · 전체 보기 줄의 로고 자리 · 로고+이름 묶음을 공용 컴포넌트로 · 이름 표 중복 · 탭 에이전트 두 번 계산) — 화면을 보지 않고 구조를 바꾸지 않는다.

## 돌려야 할 e2e (돌리지 않음)
글자는 그대로라 통과할 것으로 보지만 구조가 바뀐 곳: `ux-polish.spec:58,61` · `chat-codex.spec:61`(배지 `toHaveText('Codex')` 정확 비교) · `chat-entry.spec:48-61` · `chat-first.spec:55,109,122,125` · `agent-hooks.spec:68-110` · `remote-workspace.spec:105,114,121` · `responsive.spec:48-60`(대화 머리 가로 넘침) · `agent-sessions.spec:108,130-160,252` · `conversation-search.spec:45` · `overview.spec:51-85` · `usage.spec:92-95` · `readability.spec`.

## 계획과 다르게 한 것
- `AgentIcon` 은 JSX 없는 `.ts`(`createElement`) — `tests/` 를 검사하는 tsconfig 에 jsx 설정이 없어 `.tsx` 를 단위 시험이 import 하지 못한다.
- 로고 + 이름 묶음은 `align-items: baseline` 에 로고만 가운데(가운데 맞춤이면 이름이 옆 글자보다 올라간다는 추론 — 화면 미확인). 말줄임하는 줄(탭 · 사이드바)은 가운데.
- 계획에 없던 것: 설정 › 새 일감 시작에도 로고 · 터미널 에이전트 탭의 로고(리뷰) · `THIRD_PARTY_NOTICES.md` 와 패키지 검사.
- 실제 화면 UI/UX 리뷰는 하지 않았다 — 사용자가 새 빌드를 직접 본다.

## 미검증
- 실제 모양 전부: 세로 맞춤 · 줄/단추 높이 · 말줄임 · 다크/라이트 색(Claude 주황의 라이트 바탕 대비는 계산값 약 3.1:1).
- 패키지에 고지 파일이 실제로 들어가는지(`npm run package` — 출시 준비에서 확인).
