# 쌓인 e2e (58 · 59 · 61~70) — 쓰고 돌림

2026-11-20 · 사용자 "쌓인 e2e(58 · 59 · 61~70) 를 시험으로 쓰고 돌려줘 — 이번엔 임시 데이터 폴더로 앱 띄우는 것 허락".
브랜치 `test/stacked-e2e-58-70` ← origin/main ff32dec. 앱은 모두 `TASKMINAL_USER_DATA=<임시 폴더>` 로만 띄웠고, Jira 는 시험 안 loopback 가짜 · claude/codex 는 가짜.

## 결과 한눈에

- **기준 실행**(새 시험 전, 기존 e2e 전체): 397개 중 394 통과 · 1 실패 · 2 건너뜀(packaged 등). 실패 1 = `agent-hooks.spec` — 63 이 안내를 같은 zsh 함수로 붙이면서 낡은 기대(아래).
  58 · 59 의 '기존 spec 다시 돌리기' 목록(chat · agent-sessions · schedules · workflows · settings · settings-reflow · layout-align · responsive · tabs · terminal · keys · palette · window · ux-polish · chat-codex · chat-entry · chat-first · remote-workspace · conversation-search · overview · usage · readability)과 67:9 · 69:6~7 · 70:6(worktrees · worktree · archive · cli · workflows)은 이 실행에서 모두 통과.
- **새 시험**: 64개 — 새 파일 11개에 63개 + `agent-hooks.spec` 에 1개(아래 표). 시험이 찾은 화면 버그 4건을 고쳤다.
- **전체 검사**(`full-check.sh`): typecheck · 경계 · vitest · e2e 457 통과(흔들림 0), 종료 0. 리뷰 반영 뒤 바뀐 spec 6개(35개)를 다시 돌려 통과.
- **변이**: 고친 4곳을 되돌림 + 새 시험의 핵심 5곳(63 훅 끔 · 66 보는 pane · 69 보낸 이 머리 · 64 댓글 이미 남음 · 63 codex 설정에 이미 안내) — 9개 모두 잡음.

## 시험이 찾은 것 · 고친 것

| # | 단계 | 증상 | 원인 | 고침 | 시험 |
|---|---|---|---|---|---|
| 1 | 65 | ⌘P 파일 범위로 하위 폴더 파일을 고르면 파일 보기가 그 폴더로만 가고 파일은 안 열림(파일 보기가 새로 열릴 때, 15/15) | 처음 열 때의 루트 목록 답이 `src/deep` 로 다시 그리기 전에 도착 → 번호가 아직 같아 열 파일 기억(`pendingOpen`)을 지움 | `WorkspaceFiles.tsx` — 그 파일의 폴더 답일 때만 쓰고 지움 · 사용자가 직접 폴더를 옮기면(줄 · 상위 폴더) 비움 | `palette-files.spec.ts:41` |
| 2 | 68 | 하위 에이전트 카드가 18px 로 눌려 '하위 도구 1개' 단추가 가려짐 · 라이트 대비 1.04 · 대화 머리 'Claude' 배지가 세로 상자로 | 카드가 머리 배지와 같은 클래스 `.chat-agent` | 카드 쪽 클래스를 `chat-subagent*` 로(testid 는 그대로) | `subagent-progress.spec.ts:58 · 162` |
| 3 | 67 | 워크트리 패널 오류 글에 `Error invoking remote method '…': Error:` 머리 | 패널의 `message()` 만 걷지 않음 | 다른 화면과 같은 정규식으로 걷음 | `worktree-cleanup.spec.ts:202` |
| 4 | 70 | 좁은 창(320 CSS px)에서 가져오기 대화상자 단추 넷의 글자가 세로로 꺾임 · 낮은 창(200 CSS px)에서 목록이 한 줄도 못 담게 눌려 줄이 단추 밑으로 새어 그려짐 | 단추 줄 줄넘김 없음 · 스크롤되는 flex 세로 대화상자 안에서 `overflow:auto` 목록이 0 까지 줄어듦 | `repo-import.css` — 단추 줄 `flex-wrap` · 단추 `nowrap` · 목록 `flex-shrink: 0` | `import-repo.spec.ts:262`(단추 글자 한 줄 · 목록 높이 ≥ 첫 줄) |

그 밖에 시험 쪽 고침: `agent-hooks.spec` '설정을 끄면 감싸지 않는다' 는 63 이후 안내(agentGuide, 기본 켬)도 같은 함수가 붙여 낡음 → '두 설정 모두 끄면 감싸지 않음' + '훅만 끄면 안내만 붙고 `--settings` · 기록 파일 · 변수 없음' 두 시험.

## 항목 ↔ 시험

| 문서 항목 | 시험 |
|---|---|
| 58b 대화 claude 안내 · 끄기 | `agent-guide.spec.ts:114 · 129` |
| 58c 파일 끌어 놓기 | `terminal-gestures.spec.ts:53` |
| 58c OSC 52 켬 · 끔 | `terminal-gestures.spec.ts:97 · 109` |
| 58c 탭 순서 · 재시작 유지 | `terminal-gestures.spec.ts:122` |
| 61 다른 지킴이 보기 · 끝내기 · 내 것 없음 | `host-scan.spec.ts:64` |
| 62 links 미리보기 · 링크 · 이미 있는 것 그대로 | `worktree-links.spec.ts:48` |
| 63 대화 Codex · 터미널 claude/codex 켬 · 끔 · codex 설정에 이미 안내 | `agent-guide.spec.ts:114 · 129 · 179 · 190 · 200`, `agent-hooks.spec.ts:139 · 153` |
| 64 상태 바꾸기 · 댓글 · 응답 끊김(전환 반영됨 / 댓글 반영됨 / 댓글 안 됨) · 결과 지우기 · 배경 | `jira-write.spec.ts:143 · 157 · 172 · 195 · 212 · 244` |
| 65 ⌘P 파일 범위 · 내용 찾기 줄 | `palette-files.spec.ts:41 · 66 · 80` |
| 66 1~7 | `inbox.spec.ts:93 · 126 · 166 · 185 · 201` |
| 67 1 · 2 · 3 · 4 · 6 · 7 · 8 | `worktree-cleanup.spec.ts:77 · 106 · 139 · 158 · 180 · 202 · 226 · 245` |
| 68 1~6 | `subagent-progress.spec.ts:58 · 85 · 103 · 119 · 139 · 162 · 268` |
| 69 1~5 | `agent-delegation.spec.ts:85 · 101 · 113 · 140 · 158 · 194 · 231 · 257 · 274` |
| 70 1~5 · 7~10 | `import-repo.spec.ts:121 · 162 · 178 · 196 · 212 · 262 · 338 · 355 · 394 · 422` |

## 계획 · 문서와 다르게 한 것

- **67-5 안 씀**: 정리 중 이름 바꾸기 · 선택 저장 · 되살리기는 겹치는 틈이 `worktree-management.ts` 의 lsof 몇십 ms 뿐이라 시험에서 붙잡을 수 없다 — env 로 켜는 대기 지점 같은 시험용 장치가 있어야 한다. 보관 → main 지움 순서 자체는 1 · 4a 가 지난다.
- **67-6 기대가 틀렸음**: 문서는 '읽기 전용에서도 정리 흐름까지 가고 그 줄만 안 함' 을 기대했지만, 읽기 전용이면 renderer 가 상태를 main 에 보내지 않아(`App.tsx` canSave) 39 의 폴더 권한 검사가 목록부터 거절한다(안전한 쪽). 시험은 실제 동작(이유 한 줄 · 정리 단추 꺼짐 · 폴더 · 일감 그대로)을 본다.
- **67-8**: 200px 사이드바는 따로 두지 않고 좁은 창(320 CSS px) · 200% · 라이트/다크로만.
- **69 CLI 호출**: 대화 pane 의 claude 가 부르는 대신 `TASKMINAL_PANE_ID` · cwd 를 준 CLI 로 흉내. 69-2 '창을 닫은 채' 는 창으로 가는 `delegate.prepare` 만 main 에서 버려 '결과 모름' 길을 지남(창을 실제로 닫으면 앞 단계에서 실패해 worktree 를 안 만든다). 69-5c '부모 지움' 은 지운 부모의 pane 이 없어 받은편지함이 버리므로 화면 신호가 없다 — 가드는 단위 시험(`delegation-model.test` '부모가 지워졌거나 …')이 본다.
- **70-8**: 문서의 '두 번 빠르게' 는 첫 번째가 성공해 후보가 사라지므로 '53 패널에서 여는 중에' 쪽으로. **70-10**: 보관은 대화상자가 열린 동안 앱 명령이 막혀 닿을 길이 없어 CLI 지우기만.
- **58c 끌어 놓기**: 실제 Finder 끌기가 아니라 숨은 file input 의 File 로 drop 이벤트. 넣지 않는 경우(제어 글자 · 끝난 셸 · 시작 명령 대기)와 탭 끌기는 안 씀.
- **58a 원격 입력 묶어 보내기에 지연을 넣은 e2e** 는 이번에도 안 씀(문서의 '아직 없다' 그대로). `remote-terminal-depth.spec` 전체는 통과.
- 가짜 claude 는 글에 'ask' 가 들어 있으면 질문 대본을 고르는데, 보낸 이 머리의 'taskminal' 에 'ask' 가 있어 69-5 의 맡긴 일감 대화는 앱 밖 CLI 로 띄웠다(fixture 낱말 대본 한계).

## 리뷰 (`/code-review` medium, 8건)

| # | 지적 | 처리 |
|---|---|---|
| 1 | 69-5c '부모 지움' 은 늘 참 | 주석 · 위 절에 적음(단위 시험이 가드를 봄) |
| 2 | 67-5 없음 · 8 의 200px 사이드바 | 머리 주석 바로잡고 위 절에 적음 |
| 3 | 64 댓글이 실제로 남았는데 응답만 끊김(중복 댓글) 미시험 | 시험 추가 `jira-write.spec.ts:195` · 변이(landed 늘 false) 잡음 |
| 4 | agent-hooks 의 `--settings` 단정이 늘 참 | FAKE ARGS 첫 인자부터 단정 |
| 5 | host-scan '닫기' 뒤 지킴이를 바로 읽음 | 1.5초 기다린 뒤 |
| 6 | worktree-cleanup 취소 뒤 호출 수를 바로 읽음 | 1초 기다린 뒤 |
| 7 | IPC 머리 정규식 여섯 번째 복사 | 둠 — 다섯 곳을 한 함수로 모으는 것은 이 작업 밖, 후보 |
| 8 | codex 설정에 이미 developer_instructions 미시험 | 시험 추가 `agent-guide.spec.ts:190` · 변이(앱 · zsh 두 겹 함께 되돌림) 잡음. 한 겹만 되돌리면 다른 겹이 막아 통과하는 것이 설계 |

## 직접 본 화면

`test-results/stacked-e2e/` · `test-results/*.png`: 66 받은편지함 줄 · 67-8 좁은 창 라이트 · 68 카드(고친 뒤 — 배지 알약 모양 복구) · 70-5 가져오기(고치기 전 · 뒤). 세션 사진은 커밋하지 않는다.

## 미검증

실제 Finder 끌기 · 실제 클립보드 앱 사이 붙여넣기 · 실제 Jira · 실제 claude/codex(백그라운드 하위 에이전트 순서, 보낸 이 머리 인식) · 한글 IME ⌥ 키 · VoiceOver.
