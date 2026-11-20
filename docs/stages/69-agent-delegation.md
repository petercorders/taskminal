# 69 — 에이전트가 일을 맡기기

사용자 2026-11-19 "진행해줘" — `docs/ideas/next-five-v6.md` 4번. 자율 진행(계획 승인 묻지 않음), 선택은 추천안.
**사용자 지시: e2e 는 돌리지도 새로 쓰지도 않고 앱도 띄우지 않는다** — 검증은 typecheck · 경계 · 단위 · 변이까지다.

## 무엇
- `taskminal task new <이름> --worktree <새 브랜치> [--base <ref>] [--request <번호>]` — CLI 를 친 폴더의 저장소에 39 의 worktree 만들기(요청 번호 · 기록 · 같은 요청은 결과 조회)로 새 브랜치 worktree 를 만들고, 그 폴더로 **부모 일감을 기록한** 새 일감을 만든다. 출력은 한 줄 문장(일감 id · 폴더 · 브랜치), 일감 id 만은 `--json` 의 `task`(`{ task, path, branch, request, existing }`).
- 다른 pane 이 `chat send` · `chat new` 를 부르면 받는 대화 글 앞에 보낸 이 머리 `[taskminal: 일감 › 탭 (pane id) 에서 보냄]`. 터미널 `pane send` 에는 붙이지 않는다(리뷰 1 — 아래 '계획과 다르게 한 것').
- 맡긴 일감의 대화 턴이 끝나거나 실패 · 멈춤 · 허락/질문으로 멈추면 부모 일감에 알림(확인 필요 · macOS 알림 · 66 받은편지함 — CLI `taskminal notify` 와 같은 길).

## 0. 45단계(병렬 worker)와의 경계

| | 45 실행(workflow) | 69 CLI 위임 |
|---|---|---|
| 모양 | DAG(단계 · 선행 · 동시 수), 실행 기록 · 재시도 · 멈춤 | **단발** — 일감 하나를 만들고 끝. 실행 기록 없음 |
| 대화 자리 | 같은 일감 안 대화 탭(`workflow.prepare`) | **새 일감**(부모 기록). 대화는 에이전트가 이어서 `chat new --task <id>` |
| worktree 서비스 | 자기 `WorktreeManagement` · 기록 `<userData>/workers/journal.json` | 39 화면과 **같은 인스턴스** · 기록 `<userData>/worktrees/journal.json` |
| 요청 번호 | `worker-<sha(run:step)>` | CLI 가 만든 uuid 또는 `--request` |
| 브랜치 · 경로 | `taskminal/worker-<해시>` · `<userData>/workers/<run>/<step>` | 사용자가 준 브랜치 · `<기본 worktree 의 부모>/<이름>-worktrees/<브랜치 slug(소문자, 글자가 바뀌면 -해시6)>` |

- 요청 번호: 기록 파일이 달라 45 와 69 는 부딪히지 않는다. 39 화면과 69 는 한 기록을 같이 쓴다(둘 다 uuid). 같은 번호를 다른 요청에 쓰면 39 가 '다른 요청에 이미 사용한 번호예요' 로 막는다.
- 잠금: `repositoryLocks`(commonDir 키)는 모듈 수준이라 39 · 45 · 69 의 같은 저장소 worktree add · remove 가 한 줄로 선다.
- 같은 브랜치: CLI 는 `taskminal/worker-` 로 시작하는 이름을 거절(종료 2). 이미 있는 브랜치는 39 `create` 가 잠금 안 · 기록 전에 '이미 있는 브랜치예요' 로 막는다 — 전에는 `git worktree add -b` 가 실패(종료 255)해 '결과 모름' 영수증만 남았다(39 화면도 같이 좋아짐).
- 45 코드는 고치지 않았다.

## 설계
- CLI(`src/main/cli/cli-entry.ts`): `--worktree` 인데 `--request` 가 없으면 uuid 를 붙이고, 친 폴더(`process.cwd()`)를 `from` 으로 싣는다(`withRequestId`). 실패 · 연결 끊김 · Ctrl-C 면 stderr 에 '같은 명령에 --request <번호>' 한 줄(`retryHint`).
- main(`src/main/delegation.ts`): ① `self` 없음 → 종료 2 ② 창에 `delegate.source`(부른 pane 의 일감 · 폴더, 원격 · 없는 템플릿/상태/묶음 이름은 쓰기 전에 종료 2, 같은 요청 번호의 일감 id 로 **이미 만든 일감(같은 부모)이 있으면 그 폴더** — 그러면 git 없이 `existing: true` 로 끝) ③ `from`(없으면 pane 폴더)에서 `git rev-parse --is-inside-work-tree` — 128 · `false` 면 **종료 2 '저장소가 아니에요'**(`~` 폴더는 펼친다) ④ `targets` 의 기본 worktree 옆 경로로 39 `create`(기준 기본값 `HEAD` = 부른 worktree 의 HEAD) ⑤ `created` 면 창에 `delegate.prepare` — 일감 id 는 요청 번호의 sha256(uuid 모양, `delegatedTaskId`), 부모 `{ taskId, paneId }`. App 이 `issue.prepare` 처럼 바로 저장.
- 창(`src/renderer/cli-bridge.ts`): `delegate.prepare` 는 같은 id 일감이 같은 폴더 · 같은 부모면 그대로(existing), 다르면 거절. 템플릿 · 상태 · 묶음 풀기는 `task new` 와 한 함수(`pickNew`).
- 요청 번호 · 브랜치 · 기준의 모양 검사는 39 와 한 함수(`isWorktreeRequestId` · `isWorktreeBranchText` · `isWorktreeBase`, `src/shared/worktree-management.ts`) — CLI 해석 · 소켓 검사 · 39 `create` · 기록 파일이 같이 쓴다.
- 보낸 이: 창이 `pane.resolve` · `chat.new` 답에 `sender`(부른 pane 이 받는 pane 과 다를 때만)를 싣고, main 이 대화에 보낼 때 `withSender` 로 머리 줄 + 글. `/` 로 시작하는 글(대화 명령)엔 붙이지 않는다. 터미널 `pane send` 는 글 그대로. `self` 가 없거나(앱 밖 터미널) 사람이 입력칸에 친 글에는 붙지 않는다.
- 부모 알림(`src/renderer/App.tsx` 전역 대화 사건 듣기): 맡긴 일감의 pane(`isDelegatedPane`)만 `delegateSignal` 에 — 멈춤 사건(`turnStop`: 턴 끝 · 오류 · 허락 · 질문 · 멈춤)마다, 한 턴에 한 번(새 턴 `user` · 허락 뒤 `answered` · 닫힌 뒤 본 에이전트의 글 · 도구에서 다시 연다 — 오류 뒤 이어 간 턴 · 백그라운드 일 뒤 스스로 이어 간 턴의 끝도 알린다). 68 의 `agent`(하위 에이전트) · 하위 에이전트의 도구는 멈춤도 다시 열기도 아니다. `parentNotice` 가 그 순간 상태에서 부모 · 맡긴 pane 을 다시 찾는다(맡긴 pane 이 사라졌으면 부모의 활성 pane, 부모가 지워졌거나 보관이면 조용히). `turnStop` 은 `chat wait` 와 한 규칙(cli-server 의 `stopState` 를 옮겼다). <!-- refs-ignore -->
- 재시작: main `history()` 가 열린 턴을 닫는 '멈춤' 은 main 쪽 듣는 곳에만 가고 창에는 보내지 않는다 → 재시작이 부모 알림을 쏟지 않는다(코드로 확인).
- 상태: `Task.parent?: { taskId; paneId? }`(옛 상태는 없음 그대로, 자기 자신 · 모양 틀린 값은 버림). 67 의 revision 규칙(`worktreeUseKey`)과 맞다 — 새 일감은 폴더가 바뀌어 revision 이 오르고, `parent` 만 바뀌는 일은 없다. 커밋 없는 새 worktree 는 67 기준 '병합됨' 이 아니라 정리 후보가 되지 않는다.

## 칸 (결과 모름 · 다시 시도 · 이중 입력 · 취소 · 그 사이 바뀜)
- 결과 모름: 39 `create` 가 `unknown` → 일감을 만들지 않고 종료 1 + 같은 번호 안내. worktree 는 `created` 인데 창이 답하지 않음(창 없음 · 시간 넘김) → 종료 1 'worktree 는 만들었어요(<경로>) — 일감을 만들었는지 확인하지 못했어요 · 창에 늦게 생길 수 있어요' + 같은 번호 안내(늦게 답한 창이 일감을 만들 수 있어 '못 만들었다' 고 단정하지 않는다).
- 다시 시도: 같은 번호 → 창에 같은 id 일감(같은 부모)이 있으면 git 없이 그 일감을 알림(그 사이 worktree 에 커밋해도 39 의 '결과 모름' 에 걸리지 않게). 없으면 39 영수증으로 `worktree add` 를 다시 하지 않고 등록만 다시 읽은 뒤 그때 일감을 만듦.
- 이중 입력: 같은 번호 둘이 겹치면 잠금이 줄 세워 두 번째는 영수증 길. 다른 번호 · 같은 브랜치 → '이미 있는 브랜치예요'. 같은 경로 → 39 '이미 있거나 … 겹치는 경로예요'.
- 취소: Ctrl-C 는 기다림만 버린다(앱의 만들기는 끝까지) — 안내된 번호로 다시 부르면 결과를 받는다.
- 그 사이 바뀜: 부모가 지워져도 일감은 기록한 부모 id 로 만든다(알림만 조용히 빠짐). 템플릿 등 이름은 `delegate.prepare` 때 다시 푼다.
- 앱 종료 4경로: worktree 만들기는 main 에서 끝까지(영수증), 일감은 창이 없으면 안 생김 → 같은 번호로 이어 감. 창이 없던 동안의 턴 끝은 부모에 알리지 않는다(그 pane 자신의 알림과 같은 한계).

## 코드와 시험
- `src/shared/delegation.ts`(머리 · 브랜치 이름 · `delegateSignal` · `isDelegatedPane` · `parentNotice`), `src/shared/chat.ts`(`turnStop`), `src/shared/cli.ts`(해석 · 소켓 모양 · `withRequestId` · `retryHint` · `delegate.*` 창 요청 · `sender`), `src/shared/worktree-management.ts`(모양 검사 함수), `src/shared/model.ts` · `src/shared/types.ts`(`parent`), `src/main/delegation.ts`, `src/main/cli-server.ts`, `src/main/worktree-management.ts`(이미 있는 브랜치 · 모양 검사 함수), `src/main/index.ts`(39 인스턴스를 위임에), `src/main/cli/cli-entry.ts`, `src/renderer/cli-bridge.ts`, `src/renderer/App.tsx`, `src/shared/agent-guide.ts`.
- 시험: `tests/unit/delegation-model.test.ts`(12) · `tests/unit/delegation.test.ts`(12, 실제 임시 git) · `tests/unit/cli.test.ts`(+5) · `tests/unit/cli-server.test.ts`(+4) · `tests/unit/cli-bridge.test.ts`(+4) · `tests/unit/worktree-management.test.ts`(+1).

## 결과
- 단계 끝 검사 `FULL_CHECK_NO_E2E=1 … full-check.sh` 종료 4(typecheck · 경계 · 단위 통과, e2e 미실행) — 첫 커밋 때 단위 1,674, 리뷰 고침 뒤 1,679(136 파일).
- 변이 10개(핵심 줄만, batch) — 9 잡음 · 1 판정 불가(이미 있는 브랜치 검사를 `=== 99` 로 바꾼 변이가 좁혀진 리터럴 타입 비교로 컴파일 오류) → 조건을 끄는 꼴로 다시 돌려 잡음. 잡은 것: 머리 붙이기 · 같은 pane 이면 머리 없음 · 셸 입력엔 머리 없음 · 한 턴에 한 번 · 보관된 부모는 조용히 · `.git` 안은 종료 2 · 이미 있는 브랜치 · 같은 id 일감이면 그대로 · 일감 id 를 요청 번호에서 · 상태 파일이 parent 를 읽음.
- 리뷰 고침 변이 9개(따로 batch) — 9 잡음: `/` 명령에도 머리 · 글 · 도구로 다시 열지 않음 · 하위 에이전트 도구도 다시 엶 · 모든 pane 을 표에 · 이미 만든 일감 조기 반환 없음 · 친 폴더 무시 · 소문자 아님 · 해시 없음 · 다른 부모의 일감도 existing.

## 계획과 다르게 한 것
- 에이전트 안내에 새 줄을 넣지 않았다 — 안내가 이미 10줄 · 748자로 시험 한도(10줄 · 800자)에 차 있다. 마지막 `taskminal help` 줄 설명에 '새 worktree 일감에 맡기기(task new --worktree)' 를 넣었다(계획: 줄 하나 더하기).
- **터미널 `pane send` 에 보낸 이 머리를 넣지 않는다**(지시서 · 계획: 다른 pane 이 `pane send` 를 부르면 머리). 리뷰 1 — `pane send` 는 키 입력이라 받는 claude · codex TUI 가 허락 메뉴 · 선택지 · `/` · `!` 모드인지 알 수 없고(51 훅의 'input' 은 입력 대기와 elicitation 을 가리지 않고, codex 허락은 훅이 없다), 머리 안의 숫자가 메뉴를 고를 수 있다. 처음 구현한 '에이전트가 돌 때만 같은 줄' 판별(51 훅 · 실행 중 명령)과 그 시험을 지웠다. 대화(`chat send` · `chat new`)는 그대로 붙인다.
- 저장소를 pane 에 저장된 폴더가 아니라 **CLI 를 친 폴더**(`from` = `process.cwd()`)에서 찾는다(계획: 부른 pane 의 폴더). 리뷰 3 — 에이전트가 `cd` 한 뒤 부르면 다른 저장소 · 저장소 아님이 됐다.
- worktree 폴더 이름: 소문자 slug, 브랜치와 글자가 다르면 `-<브랜치 sha256 6자>`(계획: slug 만). 리뷰 5.
- 변이: 단계 batch 10개에 더해 리뷰 고침 9개를 따로 돌렸다(지시서: 핵심 줄 10개 이하) — 리뷰 고침이 새 판단 줄이라 잡히는지 봐야 했다.
- 계획에 없던 것: pane 폴더가 `~/…` 로 저장돼 있으면 `git -C` 가 펼치지 않아 '저장소가 아니에요' 로 잘못 거절했을 것 — 펼치도록 고치고 시험을 더했다. Ctrl-C 때도 같은 번호 안내를 찍는다. `task new` 의 이름 풀기를 `pickNew` 로 뽑아 위임과 같이 쓴다.

## 돌려야 할 e2e — 2026-11-20 쓰고 돌림

> 결과 · 항목별 시험 · 찾은 버그 · 안 쓴 항목은 `docs/stages/stacked-e2e-58-70.md`. 아래는 당시 목록 그대로.

1. 대화 pane 의 claude 가 `taskminal task new X --worktree b --json` → 새 일감(사이드바) · 폴더 `<저장소>-worktrees/b` · 상태 파일에 `parent`, 보던 일감 · 탭 그대로.
2. 같은 명령 `--request` 재전송 → 일감 · worktree 하나, 답 `existing: true`. 앱 창을 닫은 채 부른 뒤 창을 열고 같은 번호 → 일감이 생김.
3. 저장소 아닌 일감 · 원격 일감에서 부름 → 종료 2, 폴더 · 브랜치 · 기록 없음.
4. 다른 pane 에서 `chat send` → 받는 대화에 머리 줄(사용자 글 거품), 사람 입력칸에서 보낸 글 · `/compact` 같은 명령 글엔 없음. 터미널 claude 의 허락 메뉴에 `pane send 3` → 머리 없이 그 선택만. 에이전트가 `cd <다른 저장소>` 뒤 `task new --worktree` → 그 저장소에 만들어짐.
5. 맡긴 일감의 대화 턴 끝 → 부모의 맡긴 pane 이 확인 필요 · 받은편지함 '지난 알림' 한 줄. 하위 에이전트를 쓰는 턴도 한 번만. 허락 기다림 → 한 번, 허락 뒤 턴 끝 → 한 번 더. 부모를 지운 뒤 · 보관한 뒤 → 알림 없음. 앱 재시작 뒤 → 알림 쏟아짐 없음.
6. 39 `tests/e2e/worktrees.spec.ts` 전체 — `create` 에 이미 있는 브랜치 검사를 더했다(화면에서 이미 있는 브랜치로 만들면 '결과 모름' 대신 바로 오류). 45 `tests/e2e` 의 작업 흐름 격리 실행(39 `create` 를 쓴다).
7. 24 CLI e2e(있으면) — `chat send` · `chat wait` 가 같은 결과(멈춤 판정을 `turnStop` 으로 옮김).

## 미검증
- App 안의 연결 — 전역 대화 사건 듣기가 부모에 `notify` 를 넣는 것 · `delegate.prepare` 뒤 바로 저장(단위 시험이 닿지 않는다, 위 e2e 1 · 5).
- 실제 claude · codex 가 머리 줄을 사람 말과 가려 읽는지(글 모양만 단위로 봄).
- 받는 쪽은 머리를 인증으로 쓸 수 없다 — 사람이 같은 모양 글을 직접 칠 수 있다(표시일 뿐).

## 리뷰
`code-review` high, 첫 커밋 f2d99d8 대상 · 10건(등급 없이 순서로 냄 — 아래 등급은 내 판단). 고침은 따로 커밋. 모두 고쳤다.

| # | 지적 | 등급 | 처리 |
|---|---|---|---|
| 1 | 터미널 claude · codex 에 `pane send` 하면 머리 글자가 허락 메뉴의 선택을 고르거나 `/clear` 를 말로 바꾼다 | HIGH | `pane send` 에 머리를 넣지 않음(위 '계획과 다르게'). 대화도 `/` 로 시작하는 글엔 안 붙임. 시험: `pane send 3` 이 글 그대로 · `/compact` 그대로 |
| 2 | 같은 `--request` 로 다시 하면 그 사이 worktree 에 커밋했을 때 39 가 늘 '결과 모름' | HIGH | 창이 같은 id · 같은 부모 일감을 알리면 git 전에 `existing: true`. 시험: 만들기 → 커밋 → 다시 = 성공 · worktree add 1번 |
| 3 | 저장소를 pane 의 저장된 폴더에서 찾음 — `cd` 뒤 부르면 틀린 저장소 · 저장소 아님 | MEDIUM | CLI 가 `from`(친 폴더)을 실어 보냄 · 소켓 검사(절대 경로 · worktree 와만). 시험: pane 폴더가 저장소 아니어도 from 으로 성공, 반대는 종료 2 |
| 4 | 한 턴에 첫 멈춤만 알려 오류 뒤 이어진 턴 · 백그라운드 뒤 스스로 이어 간 턴의 끝을 삼킴 | MEDIUM | 닫힌 뒤 본 에이전트의 글 · 도구에서 다시 엶(하위 에이전트 도구는 아님). 시험: 오류 → 글 → 턴 끝 = 두 번, 턴 끝 → 도구 → 턴 끝 = 두 번 |
| 5 | 폴더 이름이 겹침(`feat/x` · `feat-x`, macOS 대소문자) | MEDIUM | 소문자 + 글자가 바뀌면 브랜치 해시 6자. 시험: 네 브랜치가 서로 다른 경로 |
| 6 | 창이 늦게 답하면 '일감을 못 만들었다' 뒤 일감이 생김 | MEDIUM | 안내를 '만들었는지 확인하지 못했어요 · 창에 늦게 생길 수 있어요'로. 같은 번호로 다시 하면 2 의 길로 그 일감을 받는다 |
| 7 | HELP 는 '→ 일감 id' 인데 출력은 문장 | LOW | HELP 를 '--json 의 task = 일감 id' 로 |
| 8 | 요청 번호 · 브랜치 · 기준 검사가 39 와 따로 | LOW | `src/shared/worktree-management.ts` 의 함수 셋으로 모아 CLI · 소켓 · 39 `create` · 기록 파일이 같이 씀 |
| 9 | pane → 일감 찾기를 손으로 되풀이 | LOW | `findPaneTask` 로 |
| 10 | 알림 표(pane 별)가 모든 대화 pane 으로 자람 | LOW | 맡긴 일감의 pane 만(`isDelegatedPane`) |
