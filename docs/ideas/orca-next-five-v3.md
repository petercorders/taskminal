# Orca 비교 세 번째 — 50단계 뒤에도 남은 꼭 필요한 다섯

일자: 2026-11-16. 상태: **조사 · 결정 기록, 구현 승인 아님**(`/harness-run idea Orca랑 비교 했을 때 꼭 개발 필요한 5가지`).
기준: Taskminal `origin/main` a7be63e(PR #3 으로 50단계까지 통합, 2026-11-16) · Orca 설치본 1.4.257 CLI · Orca 공식 문서 a9a0e8cd(2026-11-11 소스 사본).
앞선 두 번(v1 → 36~40, v2 → 44~48)과 31~35 · 50단계에서 만든 것은 다시 고르지 않는다.
공개 저장소라 사용자 환경의 관찰값(사용률 · 개수 · 다른 도구 이름)은 일반화해 적는다. 공개 릴리스는 계속 보류 중이다.

## 문제와 근거

대상은 이 Mac 의 사용자 본인이다. Claude · Codex 를 여러 저장소의 worktree 에서 돌리는 1인 개발자이고, 지금은 Orca 를 매일 쓰면서 Taskminal 을 그 안에서 개발한다.
문제: Taskminal 로 옮겨 오면 Orca 에서 매일 기대던 것 중 무엇이 사라지나. 비교 범위는 Orca 문서 · CLI 의 기능과 사용자의 실제 Orca 사용 흔적이다. Orca 의 모든 버전 · 기능을 감사한 것은 아니다.
제약: 사용자 Claude Code · Codex 전역 설정을 바꾸는 일은 사용자 확인 대상이다(`docs/development.md` 2절). 공개 릴리스는 보류 중이다.

| 핵심 주장 | 종류 | 근거 · 확인일 | 남은 의문 |
|---|---|---|---|
| Orca 를 매일 쓴다 — 여러 저장소에 worktree 수십 개, 일부는 에이전트가 만들고 에이전트 체크포인트 메모도 남는다 | 관찰 | `orca repo list` · `orca worktree list --json` 2026-11-16 | Taskminal 로 옮길 의사는 묻지 않음 |
| Orca 는 TUI 에이전트 상태를 출력 추측이 아니라 OSC 제목과 에이전트 훅으로 안다 | 출처 | Orca 문서 `model/agents-sessions.mdx:21` · `agents/claude-code.mdx:15` · `agents/hooks-memory.mdx:23-27` | Claude 훅 설치 경로는 문서에 없음 |
| 이 Mac 의 Claude Code 전역 설정에 Orca 상태 훅이 여러 이벤트에 걸려 있고 statusLine 도 Orca 명령이다. 둘 다 Orca 가 띄운 터미널(훅 포트 환경 변수가 있을 때)에서만 동작한다 | 관찰 | `~/.claude/settings.json` 의 키 · 명령 이름만 읽음 2026-11-16 | — |
| Taskminal 터미널에서 띄운 Claude TUI 는 '입력 기다림'을 내지 못한다. 활동은 OSC 133 · 벨 · OSC 9/777 만 보고, 벨에는 `preferredNotifChannel terminal_bell` 이 필요한데 사용자 설정에 없다 | 관찰(코드 · 설정) + 추론 | `src/shared/activity.ts` · `src/renderer/FirstRun.tsx:5` · `~/.claude.json` 2026-11-16 | 실제 앱에서 TUI 를 띄워 보지는 않음. OSC 133 기준이면 claude 가 끝날 때까지 '실행 중'일 것(추론) |
| 대화 pane(26단계부터 새 일감 기본)은 stream-json 으로 상태를 이미 정확히 안다 | 관찰 | `docs/stages/21-chat-claude.md` · `26-chat-first.md` | 사용자가 Taskminal 에서 TUI 와 대화 중 무엇을 더 쓸지 미확인 |
| Orca 는 지금 Claude(5시간 · 주간 · 모델별 주간)와 Codex(주간)의 사용률 · 풀리는 시각을 보여 준다. 조사 시점 두 공급자 모두 주간 사용률이 높았다 | 관찰 | `orca account list --json` 의 rateLimits 2026-11-16 | — |
| Taskminal 은 Claude 한도를 수치 없이 '미지원'으로 표시한다(Codex 만 app-server 수치) | 관찰 | `docs/stages/32-accounts-usage.md` · `src/shared/accounts.ts` | — |
| Orca 의 사용량 원천은 공급자 API 다(Claude 는 로그인 토큰으로 `api.anthropic.com/api/oauth/usage`, 보이는 동안 약 15분 주기) | 출처 | `agents/usage-tracking.mdx:5-19` | 공개 문서가 있는 API 인지 미확인 |
| Claude statusLine 명령이 받는 JSON 에 rate_limits(5시간 · 주간 %, 풀리는 시각)가 있다(Claude ≥2.1.80) | 출처(2026-11-10 Orca 소스 주석) | `docs/design-gaps.md` 5절 | 2.1.325 · 이 계정에서 실제 칸은 미확인 |
| 세션마다 설정을 더하는 길이 있다 — `claude --settings <file-or-json>`, `codex -c key=value` | 관찰(도움말) | `claude --help`(2.1.325) · `codex --help`(0.169.0) 2026-11-16 | 더한 훅이 사용자 훅과 합쳐지는지 · 대체하는지 미검증 |
| Taskminal 대화 기록 찾기(36)는 Taskminal 이 띄운 대화만 본다. 다른 곳에서 시작한 Claude · Codex 세션은 못 찾고 못 이어 한다 | 관찰 | v1 결정 기록의 36 줄 · `src/main` 에 `claude/projects` · `.codex/sessions` 0건 · 셸 통합에 claude/codex 0건 | — |
| 디스크에 최근 Claude · Codex 세션 기록이 백 개 안팎 있다 | 관찰 | `find ~/.claude/projects -maxdepth 2 -name '*.jsonl'` · `~/.codex/sessions` 2026-11-16 | Claude 기록은 기본 30일 뒤 지워질 수 있음 |
| Orca 는 실패한 체크를 에이전트에 넘기고(Fix broken checks) PR 체크 · 리뷰 · 코멘트를 탭에서 보여 준다 | 출처 | `review/github.mdx:13-55` · `review/commit-push.mdx:15-57` | — |
| Taskminal git 흐름(33)은 push · PR 만들기 · 병합과 체크 상태 글자까지다. 실패 로그 · 리뷰 코멘트 · 에이전트로 보내기는 없다 | 관찰 | `src/renderer/GitWorkflow.tsx:12,184` · `docs/stages/33-git-workflow.md` | — |
| taskminal 저장소에는 CI(`.github/workflows/multi-platform.yml`)와 PR #1 · #2 가 있다 | 관찰 | 저장소 2026-11-16 | 체크 실패를 에이전트에게 넘긴 횟수는 기록 없음 |
| Orca 에는 Jira 서랍(이슈 편집 · 이슈로 worktree)이 있고 Taskminal 에는 없다. 47단계는 GitHub · Linear 만 만들었다 | 출처 + 관찰 | `review/jira.mdx:10-55` · Taskminal `jira` · `atlassian`(가리기 패턴 제외) 내용 0건 · 파일 이름 0건 | — |
| 사용자가 2026-11-10 'Jira · Notion 연동'과 'AI 사용량 상시 표시'를 요청했다. 둘 다 아직 열려 있다 | 관찰(문서) | `docs/design-gaps.md` 3 · 5절 | — |
| Orca 의 이슈 · PR 연결은 거의 쓰지 않고 자동화는 없다 | 관찰 | `orca worktree list` · `orca automations list` 2026-11-16 | Jira 를 쓰는 업무 저장소가 Orca 에 없어서일 수 있음 |

## 대안과 선택

| 후보 | 사용자 가치 · 차별점 | 실행 가능성 · 비용 | 핵심 가정 · 반대 근거 |
|---|---|---|---|
| 0 현행 유지 — Orca 계속, Taskminal 은 지금 기능 | 개발 비용 0 | — | 'Taskminal 을 매일 쓰는 도구로'(plan.md) 목표와 어긋난다. 아래 1 · 2 가 없으면 옮겨 올 때 매일 보던 신호가 사라진다 |
| **1 터미널 에이전트 상태 훅** — Taskminal 안에서 띄운 claude · codex 에만 세션 단위로 훅을 더해(`--settings` · `-c`) 작업 중 · 입력 필요 · 끝남 · 허락 대기를 pane 활동 · 확인 필요 · 전체 보기 · 알림에 연결. 전역 설정 쓰기 0 | '확인 필요'가 TUI 에이전트에서도 맞게 동작한다 — 앱의 핵심 약속. Orca 는 전역 설정에 훅을 설치하지만 Taskminal 은 세션 주입이라 사용자 설정을 건드리지 않는다 | 중. 셸 통합(`resources/shell/zsh`)에 래퍼 함수 + 앱 소켓(24단계 CLI 소켓 재사용) | 가정: `--settings` 훅이 사용자 훅과 함께 돈다. 반대: 대화 pane(기본)은 이미 정확하다 — TUI 로 쓸 때만 해당. 래퍼가 사용자 alias · 함수와 겹칠 수 있다 |
| **2 Claude 한도 실수치 상시 표시** — 5시간 · 주간 · 모델별 주간 %, 풀리는 시각, 속도 경고(70 · 90%), 사이드바 아래 · 상태 줄 · 계정 화면 | 사용자 요청(11-10) 중 아직 못 한 것. 지금 주간 사용률이 높아 실제로 쓸모 있는 시점 | 중. 1 과 같은 세션 주입으로 statusLine 을 한 번 거쳐(사용자 statusLine 을 이어 부름) rate_limits 를 받는다 | 가정: statusLine 입력에 rate_limits 가 온다. 반대: statusLine 은 TUI 가 돌 때만 갱신되고 대화 pane(`-p` stream-json)에서는 돌지 않는다 → 대화만 쓰면 비어 있다. 대안 원천 ① stream-json `rate_limit_event` 의 추가 칸(미검증) ② Orca 처럼 oauth usage API(키체인 토큰 읽기 → 사용자 확인 대상) |
| **3 밖에서 시작한 에이전트 세션 기록 · 이어 하기** — `~/.claude/projects` · `~/.codex/sessions` 를 읽기 전용으로 훑어 일감 폴더별 목록 · 찾기, 고르면 대화 pane 또는 TUI 로 `--resume` | Orca 에서 쌓인 세션을 옮겨 와서도 이어 할 수 있다 — 옮겨 오는 비용을 줄인다 | 중. 36단계 찾기 화면 · 가리기(`redact`) 재사용 | 가정: jsonl 형식을 관대하게 읽을 수 있다(공개 계약 아님). 반대: 터미널에서 `claude --resume` 으로 이미 된다 — UI 는 찾기 · 일감 연결의 편의 |
| **4 CI · 리뷰를 에이전트에게 되돌리는 고리** — PR 체크 실패 로그(가린 뒤 · 상한)와 리뷰 코멘트를 git 흐름 화면에 보이고, 한 번에 그 일감의 대화로 보내기. 사이드바 · 전체 보기에 PR · 체크 칩 | Orca 의 'diff → ship' 고리(`first-session.mdx:51`)의 마지막 칸. 33단계 위에 얹는다 | 중하. `gh run view --log-failed` · `gh api` 를 main 에서 인자 배열로, 44단계 '줄별 의견 → 대화' 경로 재사용 | 가정: 사람이 보고 넘기는 고리가 필요하다. 반대: 에이전트가 이미 `gh` 로 스스로 로그를 읽는다(harness-run 흐름). 넘긴 횟수 기록이 없어 수요는 판정 보류 |
| **5 Jira 연동(읽기 먼저)** — JQL 목록 → 일감 · worktree 만들기, 사이드바 · 머리에 키 · 마감 · 스프린트, 상태 전환 · 댓글은 확인 뒤에만. 토큰은 키체인 | 사용자 요청(11-10)인데 세 번의 비교에서 계속 밀렸다. Orca 에는 있다. 47단계의 이슈 연결 모델에 공급자 하나를 더하는 일 | 중. 47단계 `src/main/issues.ts` · `IssuesPanel` 구조 재사용, Jira REST(Cloud) | 가정: 사용자가 Jira 업무를 Taskminal 에서 한다. 반대: Orca 에서 이슈 연결을 거의 안 쓴다 · Jira 댓글 · 상태 이동은 지금 에이전트가 MCP 로 한다 |
| 보류 — 에이전트 휴면 | 메모리 절약 | 중 | Orca 도 실험 기능 · 기본 꺼짐(`agents/hibernation.mdx:8-52`). 보관함(25)이 손으로 대신한다 |
| 보류 — 모바일 동반 앱 | 자리를 비울 때 응답 | 큼(Electron 밖) | 원격 서버(48)는 있으나 자리 비움 중 응답 수요가 관찰되지 않음 |
| 보류 — 에이전트 40종 · 귀속 표시 · 3-way 충돌 · 리치 마크다운 · 받은편지함 기록 | 각각 작음 | 중 | 사용자는 Claude · Codex 만 쓴다. 전체 보기(31)가 받은편지함 역할 대부분을 한다 |
| 작은 것 — 터미널에 파일 끌어 놓기 → 경로 넣기 | Claude TUI 에 그림 · 파일 경로 넘기기 | 작음 | `TerminalPane.tsx` 에 drop 처리가 검색에 없음 — 한 방법으로만 봐서 '미확인'. 다섯 밖, 1 단계에 끼워 넣을 수 있음 |

**추천 순서: 1 → 2 → 3 → 4 → 5.**
- 1 · 2 는 같은 장치(세션 단위 설정 주입)를 쓰고, 1 이 없으면 Taskminal 의 핵심 약속('확인 필요')이 TUI 에서 깨진다. 사용자가 Orca 에서 이미 이 둘(상태 훅 · statusLine)에 기대고 있다는 것이 가장 강한 관찰 근거다.
- 2 는 사용자의 열린 요청이고 지금 한도가 높다. 원천 선택이 가장 큰 불확실성이라 1 의 스파이크에서 같이 본다.
- 3 은 옮겨 오는 비용, 4 는 ship 고리 — 둘 다 이미 있는 화면 위에 얹는다.
- 5 는 사용자 요청이 분명하지만 사용 흔적이 약하다. 그래서 읽기 전용 첫 기능으로 좁히고, 시작 전에 한 가지(아래)를 확인한다.
- 임의 점수 · 시장 우위는 주장하지 않는다. 사용 빈도 · 만족도 검증은 하지 않았다.

## 다음 검증

**가장 위험한 가정(1 · 2 공통)**: `claude --settings <임시 JSON>` 으로 더한 훅 · statusLine 이 사용자 전역 훅(Orca 훅 · 다른 도구의 훅)을 대체하지 않고 함께 돌며, 전역 파일을 바꾸지 않고, statusLine 입력에 rate_limits 가 온다.
- 방법: 기술 스파이크. 임시 폴더 · 임시 파일만 쓰고 실제 설정 파일 쓰기는 0.
  - 임시 settings: Notification · Stop · UserPromptSubmit · PermissionRequest 훅이 임시 파일에 이벤트 이름 한 줄씩 쓰기. statusLine 은 입력 JSON 의 **키 목록만**(값 없음) 저장한 뒤 사용자 원래 statusLine 명령을 이어 부르기.
  - `claude --settings <임시>` TUI 로 짧은 질문 1개 + 허락이 필요한 도구 1개.
- 관찰: 이벤트별 기록 줄 · 순서, 사용자의 다른 훅이 계속 도는지, statusLine 키에 `rate_limits` 가 있는지, `~/.claude/settings.json` · `~/.claude.json` 의 mtime 변화.
- 성공: 4 이벤트 모두 기록 · rate_limits 키 있음 · 전역 파일 변화 0. 중단: 더한 훅이 사용자 훅을 대체 → 래퍼 방식을 버리고 OSC 제목 · 벨 쪽을 다시 본다. 판정 보류: rate_limits 만 없음 → 2 의 원천을 stream-json 칸 확인 · oauth API(사용자 확인)로 넘긴다.
- 비용 한도: 실제 계정 대화 1회(짧은 질문) — 주간 사용률이 높아 그 이상 쓰지 않는다. Codex(`codex -c`) 는 같은 방식으로 뒤에.
- 실행 상태: **설계만, 실행하지 않음**(실제 계정 사용량을 쓰므로 다음 단계 계획에서 진행).

나머지 가정의 가장 싼 확인
- 3: 로컬 세션 jsonl 전부를 읽기 전용으로 해석해 실패율 · 시간을 잰다(사용량 0, 원문은 화면 · 로그에 남기지 않음). 실패율이 높으면 '세션 id · 폴더 · 시각'만 보이는 얕은 목록으로 줄인다.
- 4: 수요 근거가 없다. 판정 보류로 두고 1~3 뒤에 다시 본다.
- 5: 사용자에게 한 가지만 묻는다 — 'Jira 를 쓰는 업무 저장소를 Taskminal(또는 Orca)에서 열 생각이 있는가'. 아니면 5 는 보류하고 휴면 · 끌어 놓기를 올린다.

## 결정과 다음 작업

결정: **실험 설계 완료**(1 · 2 공통 스파이크) · **추가 조사**(3 · 4 · 5). 다섯 모두 개발 계획 전이며, 이 문서는 구현 승인이 아니다.
다음 행동(추천): 1 · 2 스파이크 → 통과하면 `/harness-run electron 51단계 에이전트 상태 훅 · Claude 한도` 로 계획 → 구현. base 최신 `origin/main`, 브랜치 `feat/agent-hooks-usage`.

1 의 첫 수직 기능(검증된 요구의 구현이 아니라 스파이크 뒤의 첫 구현)
- Taskminal 터미널에서 띄운 `claude` 만 셸 통합 래퍼가 `--settings` 를 더한다. 훅 이벤트 → 앱 소켓 → pane 활동(작업 중 · 입력 필요 · 끝남 · 허락 대기)으로 바꾸고, 사이드바 · 전체 보기 · 알림은 기존 길을 그대로 쓴다.
- 인수 조건: 가짜 claude 로 이벤트별 활동 e2e, 실제 claude 1회 대조, 전역 설정 파일 변화 0, 래퍼를 끄는 설정, 사용자 alias · 함수가 있으면 감싸지 않음.
- 범위 밖: Orca 처럼 전역 설정에 훅을 설치하기(사용자 확인 대상), 40종 에이전트, 원격 일감의 훅.
