# 51~55 — Orca 비교 v3 다섯 기능

사용자 2026-11-16 `/harness-run electron 전부 개발 진행해줘`. 근거 · 순서는 `docs/ideas/orca-next-five-v3.md`. base `origin/main` add6dd6, 브랜치 `feat/orca-gap-v3`(worktree `~/orca/workspaces/taskminal/orca-gap-v3`).
자율 진행 지시(메모리)대로 계획 승인을 묻지 않고 이 문서와 plan-check 로 대신한다. 지키는 것: 사용자 Claude · Codex 전역 설정 쓰기 0 · 실제 데이터 폴더 안 씀(e2e 는 `TASKMINAL_USER_DATA` 임시 폴더) · 공개 릴리스 보류 · Jira · GitHub 에 쓰는 요청 없음(읽기만).

## 스파이크 결과 (2026-11-16, 실제 claude 2.1.325 `-p` 1턴, 스크립트 · 로그는 scratchpad `spike1/`)
- `--settings` 로 더한 훅은 사용자 훅과 **합쳐진다** — SessionStart 훅 5개 시작(사용자 4 + 더한 1). 더한 SessionStart · UserPromptSubmit · Stop 이 모두 불렸다.
- 훅 프로세스는 제어 터미널이 없어 `/dev/tty` 쓰기가 3번 모두 실패했다 → OSC 로 pane 출력에 싣는 길은 쓸 수 없다 → **pane 별 기록 파일**로 보낸다.
- stream-json `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt,status}` 가 실제로 온다(utilization 0~1, resetsAt 초).
- `~/.claude/settings.json` 수정 시각 변화 없음.
- TUI 는 이 Mac 에서 신뢰 · 새 MCP 승인 화면이 먼저 떠서(고르면 사용자 설정에 기록된다) 자동 대조를 멈췄다. TUI statusLine 입력의 `rate_limits` 는 출처 기반(Orca 소스 주석 · design-gaps 5절)이며 **실제 대조 안 함**.

## 51 터미널 에이전트 상태 훅

| 무엇 | 어떻게 |
|---|---|
| 훅 파일 | main 이 시작 때 `<userData>/agent-hooks/`(0700)에 `claude-settings.json`(UserPromptSubmit · PreToolUse · PermissionRequest · Notification · Stop · StopFailure · SessionEnd → `claude-hook.sh`, statusLine → `claude-statusline.sh`) · `codex-notify.sh` 를 원자적으로 쓴다. 내용이 같으면 그대로 둔다 |
| 기록 파일 | pane 환경 변수 `TASKMINAL_AGENT_EVENTS=<userData>/agent-events/<paneId>.log`(폴더 0700). 훅은 stdin JSON 에서 `hook_event_name` · `notification_type` 만 뽑아 `v1⇥<초>⇥claude⇥<사건>⇥<종류>` 한 줄을 덧붙인다. 프롬프트 · 도구 입력은 디스크에 쓰지 않는다. 변수가 없으면 아무것도 안 하고, 늘 출력 없이 exit 0(허락 결정에 끼지 않음) |
| 셸 통합 | `TASKMINAL_AGENT_HOOKS=1` 이면 zsh `claude` 함수가 `command claude --settings "$TASKMINAL_CLAUDE_SETTINGS" "$@"`. 감싸지 않는 경우: 사용자 alias · 함수가 이미 있음 · 인자에 `--settings` · 첫 인자가 하위 명령(mcp · config · update · doctor · install · migrate-installer · setup-token · plugin · auth). `codex` 함수는 `-c notify=[…]` 로 턴 끝을 알린다(사용자 `~/.codex/config.toml` 에 notify 가 있으면 감싸지 않음) |
| 추가 계정 TUI | `accounts.tuiCommand` 의 `env -i` 목록에 두 변수를 넘기고 `--settings` 를 직접 붙인다(env -i 는 셸 함수를 거치지 않는다) |
| 감시 | main `AgentEvents`: 폴더 감시 + 파일별 읽은 위치. 줄마다 엄격 해석(모르는 줄 · 반쪽 줄은 버리고 다음 줄바꿈까지 기다림). 64KB 넘으면 끝 쪽만 남기고 자름. pane 이 닫히면 파일을 지운다. 렌더러에 `pane/agent` 로 보낸다. 창 새로 고침 · 앱 재시작 뒤에는 파일의 마지막 사건으로 지금 상태를 다시 보낸다(셸 지킴이로 살아 있는 claude) |
| 활동 모델 | `ActivityEvent {type:'agent', agent, phase}` · phase = working · permission · input · done · failed · ended. `PaneActivity.agent = {agent, phase, at}`. working → 실행 중 · 주의 끔. permission · input → 기다림(보고 있으면 주의 없이 상태만). done → 끝남(보지 않을 때 주의 — 다음 지시를 기다림). failed → 실패. ended → agent 지움 |
| 알림 | permission · input · done(보지 않을 때) → 기존 '입력 기다림' 알림 설정을 따른다 |
| 화면 | pane 머리 · 사이드바 둘째 줄 · 전체 보기 카드에 'Claude · 작업 중 / 허락 기다림 / 입력 기다림 / 끝남' |
| 설정 | 터미널 › '에이전트 상태 알아내기'(기본 켬). 끄면 새 셸부터 감싸지 않는다(이미 뜬 claude 는 그대로) |
| 하지 않음 | 원격 일감(훅이 원격 호스트에서 돈다) · Windows(zsh 통합 없음) · 전역 설정에 훅 설치 |

## 52 Claude 한도 실수치

| 무엇 | 어떻게 |
|---|---|
| 원천 ① | 대화 pane stream-json `rate_limit_event` 의 `unifiedWindows`(스파이크로 확인). 지금 '허용' 사건은 버리는 `src/shared/chat.ts` 해석에 사용량 사건을 더한다 |
| 원천 ② | TUI statusLine: `claude-statusline.sh` 가 입력 JSON 을 `<paneId>.status.json` 에 원자적으로 쓰고(tmp → mv), 사용자의 원래 statusLine 명령(main 이 `~/.claude/settings.json` 에서 읽어 `user-statusline.cmd` 로 둔다 — 수정 시각이 바뀌면 다시 씀, 처음 한 번만 읽지 않음)을 같은 입력으로 이어 부른다. 원래 명령이 없으면 아무것도 출력하지 않는다 |
| 저장 | main `UsageStore`: 계정별 마지막 값 {창 이름 → utilization · resetsAt · status} · at · 원천. 더 새 at 만 받는다(늦게 도착한 옛 응답이 새 값을 덮지 않음). `<userData>/usage.json` 0600 원자적 저장, 시작 때 읽어 '몇 분 전' 으로 보인다 |
| 화면 | 사이드바 아래 5시간 · 주간 막대(늘) · 계정 화면의 Claude '미지원' 을 실수치로(값이 아직 없으면 '대화나 터미널에서 Claude 를 한 번 쓰면 보여요') · 70% 노랑 · 90% 빨강 · 90% 를 넘으면 창마다 한 번 알림 |
| 부수 요청 | statusLine 은 자주 오므로 파일 감시를 250ms 로 묶고, 안 보일 때도 저장은 하되 화면 전송은 바뀐 값만 |

## 53 밖에서 시작한 에이전트 세션 기록 · 이어 하기 (worker A)

| 무엇 | 어떻게 |
|---|---|
| 읽기 | main `AgentSessions`: `~/.claude/projects/*/*.jsonl`(추가 계정은 그 `CLAUDE_CONFIG_DIR/projects`) · `~/.codex/sessions/**/rollout-*.jsonl`(추가 계정 `CODEX_HOME/sessions`). 읽기 전용, 공급자마다 최신 300개, 파일마다 앞 256KB 만 읽어 세션 id · cwd · 첫 사용자 글 · 시작 시각, mtime 을 마지막 시각으로. (경로 · mtime · 크기) 캐시. 글은 `redact()` 뒤 160자 |
| 화면 | '에이전트 세션' 패널(⌘P · 메뉴 · 작업 도구): 찾기 · 에이전트 · 범위(이 일감 폴더 / 모두) · 최신순. 동작 '대화로 이어 하기'(이 일감에 새 탭 대화 pane `{agent, sessionId}`, 세션 폴더) · '터미널로 이어 하기'(새 탭 터미널, `claude --resume <id>` · `codex resume <id>`) · 이미 이 앱에 열린 대화면 그 pane 으로 |
| 경계 | 세션 id 는 UUID 모양만(명령 주입 방지) · 폴더가 없으면 막고 안내 · 시험 루트는 `TASKMINAL_USER_DATA` 가 있을 때만 받는 환경 변수로 바꾼다(e2e 가 실제 기록을 읽지 않게) |

## 54 CI · 리뷰를 에이전트에게

| 무엇 | 어떻게 |
|---|---|
| 읽기 | `GitWorkflowService` 에 `feedback(root, pr)`: `gh pr checks <n> --json name,state,bucket,link,workflow` → 실패한 것. GitHub Actions 면 링크의 run · job id 로 `gh run view <run> --job <job> --log-failed` 마지막 120줄(가린 뒤 · 32KB 상한). 리뷰: `gh pr view <n> --json reviews,comments` + `gh api repos/{owner}/{repo}/pulls/<n>/comments` 의 파일 · 줄 · 글(가린 뒤 2000자 · 50개 상한) |
| 화면 | git 흐름의 PR 카드 아래 '체크 실패 n'(이름 · 로그 끝) · '리뷰 의견 n'(작성자 · 파일:줄 · 글). 고른 것을 '대화로 보내기' — 이 일감의 대화 pane 입력칸에 초안으로 넣는다(자동 전송 안 함, 대화 pane 이 없으면 새 탭 Claude 대화) |
| 경계 | gh 는 main 에서 인자 배열로만 · PR 번호는 숫자 · run/job id 는 링크에서 숫자만 |

## 55 Jira 읽기 연동 (worker B)

| 무엇 | 어떻게 |
|---|---|
| 인증 | 사이트(https 만) · 이메일 · API 토큰. 토큰은 Electron `safeStorage` 로 암호화해 `<userData>/jira-auth.bin`(0600). safeStorage 를 못 쓰면 이번 실행 메모리에만 두고 안내. 환경 변수 `JIRA_SITE` · `JIRA_EMAIL` · `JIRA_API_TOKEN` 도 받는다. 토큰은 렌더러 · state.json 으로 보내지 않는다 |
| 목록 | JQL(기본 `assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC`) → `/rest/api/3/search/jql`(nextPageToken, 상한 100) · key · 제목 · 상태 · 마감 · 담당 · 프로젝트 |
| 연결 | 47단계 이슈 패널에 Jira 공급자 → 일감/worktree 만들기 · 기존 일감에 연결 · 사이드바 · 일감 머리에 키 · 마감(지나면 빨강) |
| 하지 않음 | 상태 전환 · 댓글(쓰기) · 스프린트 칸(사이트마다 필드 id 가 다름) · Notion |

## 공통 계약 (화면마다 시험 하나)

- 결과를 모를 때: Jira · gh 읽기가 15초 안에 답이 없거나 응답 유실이면 '응답이 없어요 · 다시 시도' 와 마지막으로 받은 값(받은 시각)을 남긴다. 쓰는 요청이 없으므로 서버엔 반영됐는지 모르는 상태는 생기지 않는다. 대화로 보내기는 입력칸 초안에 넣을 뿐 보내지 않는다. 시험: 가짜 gh · 가짜 Jira 의 지연 · 끊김.
- 다시 시도: 읽기만 다시 한다(새 요청 번호). Jira 401 · 403 뒤 토큰을 바꿔 다시 저장하면 새 토큰으로 처음부터 읽는다. 시험: 401 → 토큰 바꿈 → 목록.
- 이중 입력: 목록 · 피드백 읽기는 한 번에 하나(진행 중 다시 누르면 같은 요청을 기다림). '이어 하기' · '대화로 보내기' · '일감 만들기' 는 실행 중 단추를 끄고 main 에서도 같은 프레임 두 번을 하나로. 시험: 같은 프레임 두 번 눌러 pane · 초안 · 일감이 하나.
- 취소 · 뒤로 · 닫기: 패널을 닫아도 읽기 결과는 버리고 아무것도 만들지 않는다. 이어 하기 확인을 연 뒤 대상 세션 · 일감이 사라지면 id 로 다시 찾아 막고 안내. 시험: 열린 사이 일감 삭제.
- 늦게 도착하는 옛 응답: 목록 · 피드백 · 사용량은 요청 번호(세대)로 옛 응답을 버린다. 시험: 느린 첫 요청 · 빠른 둘째 요청 순서 뒤집기.
- 부수 요청: 감시 · 다시 읽기는 한 번에 하나, 패널이 안 보일 때 화면 갱신을 멈춘다. 건너뛴 다시 읽기는 앞 요청이 끝난 뒤 한 번 더 돈다. 시험: 느린 읽기 중 사건 3번 → 동시 요청 1.
- 처음 한 번만 읽는 값: 사용자 statusLine 명령 · 계정 목록 · 훅 설정은 새 셸 · 다시 읽기마다 지금 값을 본다(낡지 않게). 시험: 사용자 statusLine 을 바꾼 뒤 새 pane.
- 중간 단계 실패: 이어 하기 = 새 탭 만들기 → 대화 pane 의 resume 연결(또는 터미널 시작 명령). resume 도중 실패하면 만든 탭 · pane 은 지우지 않고 기존 대화 띠의 오류 · '다시 시도' 를 쓴다(다시 시도는 resume 연결부터, 탭을 또 만들지 않음). 대화로 보내기에서 새 대화 탭을 만든 뒤 초안 넣기가 실패하면 탭은 남기고 초안 글을 복사할 수 있게 안내한다. Jira 설정 저장 → 연결 확인 → 목록 중 연결 확인이 실패하면 저장한 토큰은 그대로 두고(지우기는 따로) 오류를 보인다. 시험: resume 실패 주입 뒤 다시 시도에서 탭 수 1.
- 붙는 중: resume · Jira 연결 확인 · gh 읽기는 '연결하는 중…' 글자를 보이고 15초 한도 뒤 오류 · 다시 시도로 바뀐다(끝없이 매달리지 않음). 시험: 응답하지 않는 가짜.
- 앱 종료 4경로(앱 종료 · 창 닫기 · 새로 고침 · 렌더러 충돌): 훅 기록은 파일이라 앱이 없어도 쌓이고, 다시 열 때 파일의 마지막 사건으로 상태를 맞춘다. 끝 표시(Stop) 전에 claude 가 죽거나 앱이 꺼져 열린 채 남은 '작업 중' 은, 다시 열 때 셸 통합의 명령 끝(OSC 133 D) 또는 pane 종료를 보고 닫는다. 시험: 작업 중 사건 뒤 pane 의 명령 끝 → agent 지움.
- 가짜가 흉내 내지 않는 것: 가짜 claude(받은 `--settings` 훅을 실제 sh 로 부름)는 실제 Claude 의 훅 순서 · 타이밍 · 신뢰 화면 · statusLine 주기를 흉내 내지 않는다 → 실제 claude 대조는 위 스파이크 1회(-p 모드)로 했고 TUI 는 실제 대조 안 함. 가짜 gh 는 실제 GitHub 권한 · 페이지 · 로그 크기를, 가짜 Jira 는 실제 필드 · 권한 · 한도를 흉내 내지 않는다 — 실제 대조 안 함(계정 · 쓰기 금지).

## 분담 · 순서 → verify

- 부모: 51 → 52 → 54 와 통합(IPC · preload · App 연결), 전체 검사 · 리뷰 · GC · 문서 · 커밋 · PR.
- worker A(53) · worker B(55): 각자 `origin/main` 에서 만든 별도 worktree · 브랜치, 시험 먼저 · 단위 · 관련 e2e 통과까지, 커밋만(push · merge · 다른 worker 생성 없음). 공유 파일(App.tsx · preload · api.d.ts · ipc.ts · menu.ts · palette)은 덧붙이기만 하고 부모가 합칠 때 충돌을 푼다.
1. 51 단위(훅 줄 해석 · agent 사건 · 감싸기 판정) → 실제 sh 로 훅 스크립트 → 감시 · IPC → 화면 → e2e(가짜 claude) → verify: `npx vitest run tests/unit/agent-*.test.ts` · `tests/e2e/agent-hooks.spec.ts`.
2. 52 단위(사용량 해석 · 더 새 값만) → 저장 · 화면 → e2e(가짜 claude 대화의 rate_limit_event · 가짜 statusLine) → verify: `tests/e2e/usage.spec.ts`.
3. 54 단위(실패 체크 · 링크 id · 자르기 · 가리기) → 화면 → e2e(가짜 gh) → verify: `tests/e2e/ci-feedback.spec.ts`.
4. worker 브랜치 합치기 → 런타임 연결 확인(메뉴 · 팔레트 · IPC 등록).
5. 변이 확인(핵심 줄만, batch) → full-check → `/code-review` → 고친 것 별도 커밋 → UI/UX 검토(실제 화면 · 키보드 · 좁은 창) → full-check → 문서 · 메모리 → push · PR → 병합(본인 작업 관리자 예외) → 회고.

plan-check: 서버 없음 — Jira · GitHub 는 읽기만 하고, 나머지는 로컬 파일 · 로컬 프로세스다.
