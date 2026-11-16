# 55 — Jira 읽기 연동

계획: `docs/stages/51-55-orca-gap-v3.md` 의 '55' 표와 '공통 계약'. 브랜치 `feat/gap-jira`(base `feat/orca-gap-v3` d6b0364). 47단계 이슈 패널(`docs/stages/47-issue-links.md`)에 공급자 하나를 더했다. **Jira 에는 읽기 요청만 보낸다** — 상태 전환 · 댓글 · 스프린트 칸 · Notion 은 하지 않는다. 시험은 모두 로컬 가짜 HTTP 서버로 했고 실제 Jira · Atlassian 에는 접속하지 않았다.

plan-check: 서버 없음 — Jira 는 읽기만 하고 나머지는 로컬 파일이다.

## 구현

| 무엇 | 어디 · 어떻게 |
|---|---|
| 순수 규칙 | `src/shared/jira.ts` — 사이트 검사(`jiraSite`: https 만, `http://127.0.0.1` 은 `allowLoopback` 일 때만, 계정 · 경로 · 질의 거절 → origin), 행 해석(`jiraIssue`: 제목 · 이름은 `redact` 로 가린 글자, 끝난 상태는 `closed (…)`, 마감은 `YYYY-MM-DD` 만), HTTP 상태 글(`jiraHttpError` 401 · 403 · 404 · 410 · 429(Retry-After 초 · 날짜) · 400 · 5xx), IPC 오류에서 글 꺼내기(`jiraMessage`, 표시 `[jira]`), 마감 글(`jiraDue`: 마감 지남 · 오늘 마감 · 마감 M월 D일) |
| 목록 화면 상태 | `src/shared/jira-list.ts` `JiraList` — 요청 번호로 옛 응답 버림, 같은 JQL 은 진행 중 요청을 기다림, 안 보이면 다시 읽기를 미루고 보이면 한 번, 실패해도 마지막 목록 · 받은 시각 유지 |
| 인증 · 읽기 | `src/main/jira.ts` `Jira` — 토큰은 `safeStorage` 로 암호화해 `<userData>/jira-auth.bin`(임시 파일 0600 → fsync → rename → chmod 0600). 못 쓰면 이번 실행 메모리 + 안내. 환경 변수 `JIRA_SITE` · `JIRA_EMAIL` · `JIRA_API_TOKEN` 은 저장값이 없을 때. `status()` 는 토큰 '있음' 만. 목록 `POST /rest/api/3/search/jql`(fields 8개, maxResults 50, nextPageToken 이어 읽기, 100개 상한 → `truncated`, 같은 토큰 되풀이 · 20페이지에서 멈춤), 이슈 하나 `GET /rest/api/3/issue/{id}`, 연결 확인 `GET /rest/api/3/myself`. 한도 15초(목록 읽기 전체에 하나), 응답 4 MB 상한, `redirect: 'error'`(인증 머리를 다른 곳에 안 보냄). 끊김(연결 못 함) · 응답 유실(받다가 끊김 · 머리만 오고 소켓 끊김) · 한도(답 없음)를 다른 글로 |
| 이슈 연결에 잇기 | `src/main/issues.ts` — 공급자 `jira`(목록은 커서 없이 `Deps.jira.list`, 일감 준비 전 다시 읽기는 `Deps.jira.issue`), `Issues.attach`(기존 일감에 연결: 큐 안에서 일감 존재 확인 → 같은 일감 · 같은 이슈면 기존 연결 → 이슈 다시 읽기 → 다시 일감 확인 → 저널 저장), `close` 는 Jira 거절, 저널 검사에 `due` |
| IPC | `src/main/issues-ipc.ts` — `jira:status` · `jira:save` · `jira:clear` · `jira:attach`(provider 'jira' 고정). 시험(`TASKMINAL_USER_DATA`)일 때만 127.0.0.1 허용 · `TASKMINAL_JIRA_TIMEOUT_MS` · `TASKMINAL_JIRA_NO_SAFE_STORAGE`. 채널은 `src/shared/ipc.ts`, preload `jira` 는 `src/preload/index.ts` · `src/preload/api.d.ts` 끝에 덧붙임 |
| 이슈 패널 | `src/renderer/IssuesPanel.tsx` — 공급자 'Jira', JQL 칸(기본 `assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC`), 'Jira 인증' 칸(사이트 · 이메일 · API 토큰(password) · 저장하고 연결 확인 · 저장한 토큰 지우기, 저장 중 '연결하는 중… (최대 15초)'), 목록 상태 줄(읽는 중 · 개수 · 오류 + 다시 시도 + '마지막으로 받은 목록 … 받음' · 100개 안내), 목록 · 미리 보기에 마감 글, '기존 일감에 연결' 칸(일감 고르기 → 확인 → 연 사이 사라졌으면 막고 안내), Jira 연결에는 '외부 이슈 닫기' 없음 |
| 사이드바 · 일감 머리 | `src/renderer/issue-links.ts`(앱을 열 때 한 번 + 패널이 읽을 때마다, 시작 순서로 옛 읽기 거름) → `src/renderer/Sidebar.tsx` `issueOf` 칩(`PROJ-7 · 마감 지남`, 날짜는 title) · `src/renderer/JiraTaskHead.tsx` 일감 머리 띠(키 단추 · 제목 · 상태 · 마감). 지난 마감은 `--danger` 색 + 굵게 + 글자 '마감 지남'. 스타일 `src/renderer/jira.css`(간격 `--space-*`, 12px) |

토큰이 가는 곳: renderer 는 입력칸 상태에만 잠시(저장 클릭 때 비움) → `jira:save` → main 메모리 / 암호화 파일. `status` · 오류 글(상태 코드로 만든 글, 응답 본문 안 실음) · state.json · issues.json 에는 없다.

## 공통 계약 → 시험

| 칸 | 시험 |
|---|---|
| 늦게 온 옛 응답(요청 번호) | 단위 `jira-list.test.ts` '느린 첫 요청 · 빠른 둘째 요청 순서 뒤집기' · e2e '… 늦게 온 옛 응답'(느린 JQL 뒤 빠른 JQL, 0.8초 뒤 옛 결과가 안 덮음) |
| 목록 읽기는 한 번에 하나 | 단위 `jira.test.ts` '동시 요청 1'(main) · `jira-list.test.ts` '같은 요청을 기다린다'(화면) |
| 패널 안 보일 때 갱신 멈춤 · 건너뛴 다시 읽기는 끝난 뒤 한 번 | 단위 `jira-list.test.ts` '안 보일 때 … 알림 3번은 끝난 뒤 한 번' |
| 같은 프레임 두 번 눌러도 일감 하나 | 단위 `jira-issues.test.ts`(prepare · attach 동시 두 번) · e2e '이슈로 일감 만들기'(확인 단추 DOM 두 번 → 일감 +1 · 연결 1) · '기존 일감에 연결'(두 번 → 연결 1) |
| 연 뒤 대상 일감이 사라지면 막고 안내 | e2e '기존 일감에 연결'(확인 연 사이 사이드바로 일감 지움 → '연결할 일감이 사라졌어요' · 연결 0 · main 도 `[issue-task-deleted]`) · 단위(이슈 다시 읽는 사이 사라짐) |
| 401 뒤 토큰 바꿔 저장 → 새 토큰으로 처음부터 | 단위 `jira.test.ts` · e2e '인증 저장'(마지막 검색의 Basic 이 새 토큰, nextPageToken 없음) |
| 저장 → 연결 확인 실패해도 토큰 남김 · 오류 | 단위(401 · 답 없음 둘 다) · e2e '인증 저장'('토큰은 저장했어요 … 401', status.token true) |
| '연결하는 중' 15초 한도 · 응답 유실 | 단위(답 없는 서버 300ms 한도 — 목록 · 연결 확인, 본문 중간 끊김) · e2e '붙는 중 한도'(시험 한도 1.5초 → '응답이 없어요' + 다시 시도 + 마지막 목록 · 받은 시각, 끊김 → '중간에 끊겼어요') |
| 토큰이 렌더러 · 파일로 안 감 | 단위(status JSON · 오류 글 · 파일 평문 없음 · 0600 · 임시 파일 없음) · e2e(본문 글 · 입력 값 · local/sessionStorage · state.json 에 없음) |
| 비신뢰 제목 | 단위(`ghp_…` 가림) · e2e(`<b>굵게</b>` 가 글자로 보이고 b 요소 0) |
| 재시작 뒤 연결 유지 | 단위(새 `Issues` 가 jira 연결 · due 읽음) · e2e(앱 다시 띄워 사이드바 칩 · 일감 머리) |
| 화면 규칙 | e2e: 지난 마감 칩 · 머리 글 대비 ≥ 4.5 · 12px(다크 · 라이트), 칩이 잘리지 않음, 640×520 · 200% 에서 패널 가로 넘침 없음 |

앱 종료 4경로: 토큰 파일은 rename 으로 바꿔 끼워 중간 종료에도 옛 파일이나 새 파일 하나다. 메모리 토큰 · JQL · 목록 · 패널 초안은 종료 · 새로 고침 · 충돌로 사라진다. 연결은 47 저널(`issues.json`)이라 남는다. 쓰는 요청이 없어 '서버엔 반영됐는지 모름' 상태는 없다.

## 시험 결과 (2026-11-16)

- 단위 `npx vitest run tests/unit/jira.test.ts tests/unit/jira-list.test.ts tests/unit/jira-issues.test.ts`: 24개 통과.
- 최종 검증(종료 코드 그대로): `npm run typecheck` 0 · 경계 검사 0 · `npx vitest run` 0(106파일 1,250개) · `npm run build && npx playwright test tests/e2e/jira.spec.ts tests/e2e/issues.spec.ts tests/e2e/readability.spec.ts tests/e2e/layout-align.spec.ts tests/e2e/window.spec.ts --reporter=line` 0(29개, 42.9초) · `doc-refs-check.py` 0.
- e2e `tests/e2e/jira.spec.ts` 4개(인증 저장 · 이슈로 일감 만들기 · 기존 일감에 연결 · 붙는 중 한도) 통과. 관련 e2e(`issues.spec.ts` · `readability.spec.ts` · `layout-align.spec.ts` · `window.spec.ts`)와 함께 29개 통과.
- 스크린샷 `test-results/jira-panel.png`(인증 · 목록 · 미리 보기) · `test-results/jira-task-head.png`(사이드바 칩 · 일감 머리) · `test-results/jira-narrow.png`(320 CSS px) 를 직접 열어 봤다. 처음 본 화면에서 사이드바 칩이 'PROJ-7 · …' 로 잘려 '마감 지남' 이 안 보였다 → 짧은 글 + `flex: none` 으로 고치고 '칩이 잘리지 않음' 시험을 더했다.

## 변이 확인

목록 scratchpad `jira-mutations.tsv`, `mutation-check.sh --batch … npx vitest run`: **5개 모두 잡음**(못 잡음 0 · 판정 불가 0), 22초, 모두 원복(원문 줄 수로 확인).

1. 토큰이 status(렌더러)로 감 — `jira.test.ts`
2. https 검사 풀림(`loopback = url.protocol === 'http:'`) — `jira.test.ts`
3. 옛 응답 버림 제거 — `jira-list.test.ts`
4. 페이지 안 100개 상한 제거 — `jira.test.ts`(한 페이지 30개로 바꿔 상한이 넷째 페이지 중간에서 잘리게 했다. 50개 페이지면 페이지 경계 검사가 대신 잡아 변이가 살 수 있었다)
5. 같은 일감 · 같은 이슈 연결 중복 막기 제거 — `jira-issues.test.ts`

## 계획과 다르게 한 것

- **e2e 는 safeStorage 를 끄고 메모리 길을 봤다**: macOS 의 safeStorage 는 로그인 키체인에 항목을 만들고 접근 확인 창을 띄울 수 있어, 시험이 사용자 키체인을 건드리지 않게 `TASKMINAL_JIRA_NO_SAFE_STORAGE`(시험 모드에서만 읽음)로 껐다. 암호화 파일 길(0600 · 원자적 저장 · 평문 없음 · 다시 켠 뒤 읽기)은 가짜 암호기로 단위 시험했다. 실제 safeStorage 는 미검증.
- 목록은 '다음 더 읽기' 커서 대신 한 번 읽기에 페이지를 이어 100개까지 읽고, 넘으면 'JQL 을 좁혀 주세요'. 15초 한도는 페이지마다가 아니라 그 읽기 전체에 하나.
- JQL 은 패널 초안 메모리에만 둔다(앱 재시작 뒤 기본 JQL). 저장하지 않았다.
- '기존 일감에 연결' 단추는 Jira 공급자에만 보인다. main `Issues.attach` 는 공급자 공통으로 썼지만 IPC `jira:attach` 는 provider 'jira' 고정.
- '패널 안 보일 때 갱신 멈춤' 은 주기 갱신이 아니라 '다시 보일 때 · 패널을 다시 열 때 한 번 다시 읽기' 를 문서가 숨겨지거나 패널이 닫힌 동안 미루는 것으로 했다(주기 갱신 없음).
- 사이드바 칩은 날짜 대신 짧은 글(`마감 지남` · `오늘 마감` · `마감 11/21`, 날짜 전체는 title). 일감 머리 · 패널은 날짜까지 보인다.
- 사이트는 origin 만 받는다(경로가 있는 Server/DC 주소 거절) — `/rest/api/3/search/jql` 은 Cloud API 라서.
- e2e 의 한도는 `TASKMINAL_JIRA_TIMEOUT_MS=1500`(시험 모드만). 화면 글 '(최대 15초)' 는 그대로라 시험 중엔 실제 한도와 다르다.

## 발견했지만 고치지 않은 것

- `ConfirmDialog` 두 개가 동시에 열리면 둘 다 `aria-labelledby="confirm-title"` 이라 두 번째 창의 접근 이름이 첫 창 제목이 된다(기존 문제, 이번 범위 밖). 시험은 두 번째 창을 글로 찾는다.

## 미검증

- **실제 Jira Cloud 대조 안 함**(계정 없음 · 쓰기 금지): 실제 필드 모양 · `nextPageToken`/`isLast` 동작 · 권한별 응답 · Retry-After 형식 · 410 이 실제로 오는 경우 · 리디렉트 동작. 가짜 Jira 는 이것들을 흉내 내지 않는다.
- 실제 Electron safeStorage(macOS 키체인) 암호화 · 복호화, 키체인을 바꾼 뒤 '풀지 못했어요' 안내.
- VoiceOver · IME, Windows · Linux 화면.
- `full-check.sh` 전체 e2e 는 돌리지 않았다(지시한 관련 e2e 만). 부모가 합친 뒤 전체 검사에서 확정한다.
