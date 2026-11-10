# 15c 일감 브랜치 표시

## 목표
사이드바 일감 둘째 줄에 일감 폴더의 git 브랜치를 보인다(저장소가 아니면 지금처럼 폴더). 브랜치를 바꾸면(셸에서 `git switch`) 몇 초 안에 따라간다.

## 디자인에서 옮긴 것 (캔버스 `project/Main.dc.html` 사이드바 일감 줄)
- 둘째 줄 = `where`(브랜치 — 저장소가 아니면 `~/study` 같은 폴더) + 상태 이름. 예: `ux95/round4  검토 중`, `main`, `~/study`
- `where`: `font-family: 'JetBrains Mono', monospace` · 넘치면 말줄임(`overflow: hidden; text-overflow: ellipsis`)
- 줄: `display: flex; gap: 6px; font-size: 11px; color: #9aa0a6; white-space: nowrap; overflow: hidden` · 상태는 상태 색
- 구분점(` · `) 없음 — 6px 틈
- 본문 머리 · pane 머리에는 브랜치 없음(폴더만) → pane 머리는 바꾸지 않는다

일부러 다르게 한 것:
- 글꼴: JetBrains Mono 는 앱에 없음(design-gaps '글꼴' 항목) → 앱의 고정폭 글꼴 줄 `'JetBrains Mono', Menlo, monospace` (있으면 JetBrains Mono)
- 색: `#9aa0a6` 대신 앱의 `var(--muted)`(테마 따라감, 어두운 테마 값이 같은 계열)

## 결정 (추천안으로 정함)
| 무엇 | 결정 | 이유 |
|---|---|---|
| 어느 폴더의 브랜치 | 일감 폴더(`task.cwd`) | 디자인의 `where` 는 일감마다 하나. pane 마다 다른 폴더는 pane 머리가 폴더로 보임 |
| 읽는 법 | main 이 `.git` 을 위로 찾아 `HEAD` 파일을 읽는다(worktree 의 `.git` 파일 `gitdir:` 따라감) — `git` 을 실행하지 않음 | `/usr/bin/git` 은 Command Line Tools 가 없으면 설치 창을 띄운다 · 주기마다 프로세스를 만들지 않는다 |
| 브랜치가 아닌 HEAD(detached) | 커밋 앞 7자리 | `git status` 와 같은 정보량 |
| 언제 다시 읽나 | 일감 폴더 목록이 바뀔 때 + 창이 포커스를 받을 때 + 포커스가 있는 동안 5초마다(앞 요청이 안 끝났으면 건너뜀) | 파일 몇 개 읽기라 싸다. 셸의 `git switch` 를 따라가야 함 |
| 늦게 온 옛 응답(r5cce92 ①) | 한 번에 요청 하나(앞 것이 끝나야 다음) · 폴더 목록이 바뀌면(정리) 옛 응답 버림 | 폴더를 바꾼 직후 옛 폴더 결과가 덮지 않게 |
| 매번 도는 부수 요청(②) | 결과가 같으면 상태를 바꾸지 않는다(다시 그리지 않음) | 5초마다 다시 그리지 않게 |
| 처음 한 번만 읽는 설정(③) | 없음 | |
| 상한 | 폴더 200개 · 경로 4096자 · HEAD 파일 4KB · 위로 64단계 | renderer 를 믿지 않는다 |

## 바꿀 곳
- `src/shared/git.ts` 새: `parseHead(text): string | null`(`ref: refs/heads/x` → `x`, 40/64자 hex → 앞 7자리, 그 밖 null) · `parseGitdir(text): string | null`(`gitdir: <path>`)
- `src/main/git-branch.ts` 새: `branchOf(dir)` — 위로 `.git` 찾기 → 폴더면 그 안 HEAD, 파일이면 gitdir 의 HEAD(상대 경로는 그 폴더 기준) → parseHead. 없거나 못 읽으면 null. `branchesOf(dirs)`
- `src/shared/ipc.ts` `gitBranches: 'git:branches'`(invoke(dirs) → Record<dir, string | null>) · preload `git.branches` · api.d.ts
- `src/main/index.ts` handler: fromOurWindow · 배열 · 글자 · 상한. `~` 는 `branchesOf` 가 `expandHome`(src/shared/cwd.ts, pty-manager 와 같은 규칙)으로 푼다
- `src/renderer/App.tsx` `branches` 상태 + 주기 · 포커스 · 번호 · 같으면 그대로 → Sidebar 에 `branches` prop
- `src/renderer/Sidebar.tsx` 둘째 줄: `<span class="task-where">{branch ?? shortPath(cwd)}</span>` + 상태(6px 틈, 점 없음) · `title` 에 폴더 전체
- `styles.css` `.task-sub` flex · gap 6px, `.task-where` 고정폭 · 말줄임

## 종료 경로 · 데이터
저장 없음(state.json 에 넣지 않음 — 매번 읽음). 못 읽으면 폴더를 보인다.

## 시험
- 단위 `tests/unit/git.test.ts`: parseHead(브랜치 · 슬래시 브랜치 · 한글 브랜치 · detached sha1/sha256 · 깨진 글 · 빈 글) · parseGitdir
- 단위(실제 git 저장소, 임시 폴더) `tests/unit/git-branch.test.ts`: `git init -b main` → main · `git switch -c feat/x` → feat/x · 하위 폴더 → 같은 브랜치 · `git worktree add` 한 폴더 → 그 worktree 브랜치 · detached → 7자리 · 저장소 아님 → null · 한글 폴더 · 없는 폴더 → null
- e2e(작성만 · 미실행) `tests/e2e/branch.spec.ts`: git 저장소 폴더의 일감 → 사이드바에 브랜치, 셸에서 `git switch -c` → 몇 초 안에 바뀜, 저장소 아닌 일감 → 폴더
- 변이: parseHead · gitdir 따라가기 · 위로 찾기 · 옛 응답 버리기는 화면 쪽이라 e2e 몫(미실행 목록)

e2e 미실행(사용자 지시 2026-11-10) — 돌려야 할 목록: `tests/e2e/branch.spec.ts` 3개 · 사이드바 스크린샷으로 디자인 줄 모양 대조

## 결과 (2026-11-10) — 단위까지 확인 · e2e 미실행
커밋 fbeacdc + 리뷰 반영. 단위 git 9 · git-branch 9 · cwd +1 · 변이 5/5 + 리뷰 반영 변이. e2e `tests/e2e/branch.spec.ts` 3개 · `sidebar.spec.ts` 기대값 변경은 작성만.

## 리뷰 (/code-review medium) — 8건 모두 반영
| 지적 | 처리 |
|---|---|
| e2e: 폴더 일감 기대값이 전체 경로인데 사이드바는 shortPath 로 줄임 | `/plain$/` 로 |
| reftable 저장소 HEAD 는 `refs/heads/.invalid` 자리 표시 | null → 폴더를 보인다(실제 reftable 저장소 시험) |
| `.git` stat 이 권한 오류여도 위로 올라가 바깥 저장소 브랜치를 보임 | ENOENT · ENOTDIR 만 위로, 그 밖은 null(권한 막은 폴더 시험) |
| 앞 요청을 기다리지 않음 — 느린 폴더에서 요청이 쌓임 | 요청 중이면 건너뜀 |
| 창을 안 봐도 5초 주기 | 포커스가 있을 때만 주기, 포커스를 받으면 바로 읽음 |
| close 실패가 Promise.all 전체를 거절 | close 오류 삼킴 |
| `~` 풀기 중복(pty-manager) | `expandHome` 하나로 |
| 문서의 `resolveHome` 이 코드에 없음 | 문서 고침 — doc-refs-check 가 함수 이름을 보지 않아 놓쳐서, camelCase 이름 대조를 더했다(옛 문서로 잡힘 확인) | <!-- refs-ignore -->

계획과 다르게 한 것: 늦은 응답 처리 방법(번호 → 한 번에 하나), 주기를 포커스 동안만으로(리뷰 반영). 디자인과 다르게 한 것: 위 '일부러 다르게 한 것' 2개(글꼴 · 색 변수).
