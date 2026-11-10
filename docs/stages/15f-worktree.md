# 15f git worktree 일감

## 목표
새 일감을 만들 때 작업 폴더가 git 저장소면 **"새 git worktree 에서"** 를 고를 수 있다 — 브랜치 이름을 주면 저장소 옆 폴더에 `git worktree add -b <브랜치>` 를 만들고, 일감은 그 폴더에서 연다(사이드바 둘째 줄에 15c 의 브랜치가 보인다).

## 디자인
새 일감 보드(`project/NewTask.dc.html`)에 worktree 요소 없음 → 지금 대화상자의 줄 모양(`field` · 체크 상자 · 안내 글 11px muted)을 따른다. 대화상자 자체의 디자인 차이(템플릿 카드 · 최근 폴더)는 design-gaps 에 이미 있음 — 이번에 맞추지 않는다.

## 결정 (추천안으로 정함)
| 무엇 | 결정 | 이유 |
|---|---|---|
| 보이는 때 | 작업 폴더가 저장소일 때만(15c `gitBranches` 로 확인, 입력 멈추고 300ms 뒤) | 저장소가 아니면 고를 수 없다 |
| 새 폴더 자리 | 저장소 뿌리 옆 `<뿌리>-<브랜치 슬래시를 - 로>` (예: `~/taskminal` + `stage/15` → `~/taskminal-stage-15`) | 이 프로젝트가 쓰는 `~/taskminal-work` 와 같은 모양, 저장소 안을 더럽히지 않음 |
| 브랜치 | 새 브랜치만(`-b`) — 이미 있으면 git 오류를 그대로 보여 줌 | 단순. 있는 브랜치 꺼내기는 하지 않는 것 |
| 이름 검사 | 비었음 · 공백 · `..` · `-` 로 시작 · `~^:?*[\` · `@{` · `.lock` 끝 · 100자 넘음 → 대화상자에서 바로 이유 | git check-ref-format 의 흔한 규칙(나머지는 git 이 거절 → 오류 표시) |
| git 실행 | main 이 `git -C <뿌리> worktree add -b <브랜치> <경로>` (execFile · 120초 · `GIT_TERMINAL_PROMPT=0` · `LC_ALL=C`) | 사용자가 누를 때 한 번 — 15c 의 '주기마다 git 안 씀' 과 다름 |

다단계(rf8bdd6) — ① 다시 시도: git 이 거절하면 일감을 만들지 않고 대화상자에 오류, 이름을 고쳐 다시 '만들기' ② 취소 · 뒤로: git 이 도는 동안 '만들기' · '취소' · Esc 를 막는다(몇 초) — 끝난 뒤 만든 worktree 는 그대로 일감이 된다 ③ 결과 모름(120초 넘음): "시간이 넘었습니다 — 폴더 · 브랜치가 만들어졌을 수 있어요: <경로> (<브랜치>)" 를 보이고 일감은 만들지 않음, 사용자가 확인 뒤 그 폴더로 일반 일감을 만들 수 있다.

일감을 지워도 worktree 폴더 · 브랜치는 지우지 않는다(작업을 잃지 않게 — 지우기는 `git worktree remove`). 지우기 확인 대화상자 문구는 바꾸지 않음(하지 않는 것).

## 바꿀 곳
- `src/shared/worktree.ts` 새: `checkBranchName(name)` → 이유 | null · `worktreeDir(root, branch)`
- `src/main/git-branch.ts` `repoRoot(dir)` — `branchOf` 와 같은 위로 찾기
- `src/main/worktree.ts` 새: `addWorktree(dir, branch, home)` → `{ ok: true, path } | { ok: false, error, maybeCreated? }`
- `src/shared/ipc.ts` `gitWorktreeAdd: 'git:worktree-add'` · preload `gitWorktreeAdd` · api.d.ts · main handler(fromOurWindow · 글자 · 길이)
- `src/renderer/NewTaskDialog.tsx` 체크 상자 · 브랜치 입력 · 만들어질 경로 안내 · 도는 동안 막기 · 오류 줄
- `styles.css` 오류 · 안내 줄(있는 것 재사용)

## 시험
- 단위 `tests/unit/worktree.test.ts`: checkBranchName 각 규칙 · worktreeDir(슬래시 · 한글 · 뿌리가 `/` 끝)
- 단위(실제 git, 임시 폴더) `tests/unit/worktree-add.test.ts`: 저장소 → 새 폴더 · 브랜치 생성(15c `branchOf` 로 확인) · 하위 폴더에서 불러도 뿌리 옆 · 같은 브랜치 다시 → 오류(폴더 없음) · 폴더가 이미 있음 → 오류 · 저장소 아님 → 오류 · 나쁜 이름 → git 안 부름
- e2e(작성만 · 미실행) `tests/e2e/worktree.spec.ts`: 저장소 폴더로 새 일감 → 체크 · 브랜치 → 일감 폴더가 새 worktree · 사이드바에 브랜치 · 저장소 아닌 폴더면 체크 상자 없음 · 이미 있는 브랜치 → 오류 줄, 일감 수 그대로
- 변이: checkBranchName 규칙 · 폴더 있음 검사 · 저장소 아님

e2e 미실행(사용자 지시 2026-11-10) — 돌려야 할 목록: `tests/e2e/worktree.spec.ts` 3개

## 결과 (2026-11-10) — 단위까지 확인 · e2e 는 15단계 끝 전체 시험에서
커밋 07b5c89 + 리뷰 반영. 단위 worktree 3 · worktree-add 9 · 변이 5/5 + 리뷰 반영 4/4.

**시험 중 사고 · 고친 것**: 리뷰 반영 변이에서 '절대 경로 검사' 를 지운 변이가 상대 경로 시험(`'app'`)을 시험 프로세스의 지금 폴더(= 이 저장소 `~/taskminal-work`) 기준으로 풀어, **진짜 저장소에 worktree `~/taskminal-work-x` · 브랜치 `x` 를 만들었다**(변이는 '못 잡음'). 바로 확인하고 깨끗한 상태(07b5c89, 바뀐 파일 없음)를 본 뒤 `git worktree remove` · `git branch -d x` 로 되돌림. 시험은 임시 저장소 안으로 `process.chdir` 한 뒤 상대 경로를 주게 고쳐, 같은 변이가 임시 폴더 안에서만 만들고 시험이 잡는다(잡음 확인).

## 리뷰 (직접 리뷰 — 스킬 하위 에이전트가 ~/taskminal 에서 돌던 것을 피해) — 5건 모두 반영
| 지적 | 처리 |
|---|---|
| 작업 폴더 끝 빈칸이면 없는 폴더라 위로 올라가 **바깥 저장소**에 worktree, 앞 빈칸 · 상대 경로는 main 의 지금 폴더 기준 | main · 대화상자 모두 trim, main 은 절대 경로만 |
| post-checkout 훅(husky · LFS) 실패면 worktree 는 생겼는데 '실패' — 같은 이름 다시는 '이미 있는 폴더' | 실패해도 `git worktree list` 에 등록됐으면 성공, 오류 줄은 마지막 줄 |
| 30초에 죽이면 반쯤 만든 worktree · 브랜치가 남음 | 120초, 메시지에 브랜치 · `git worktree list` 확인 안내. 훅의 자식 프로세스는 남을 수 있음(그대로) |
| 도는 동안 다른 칸을 고칠 수 있고 그 값은 버려짐 | 칸 전체를 `fieldset disabled` 로 막음. 창을 닫으면 결과를 모르는 것은 그대로(대화상자가 사라짐) |
| 폴더를 바꾼 직후 옛 '저장소' 판단 · 빈 alert · 오류가 남음 · 글 방향 제어 문자 | 확인된 폴더(`repoDir`)와 같을 때만, 오류가 있을 때만 줄, 체크를 바꾸면 오류 지움, U+200E/F · U+202A–E · U+2066–9 거절 |

계획과 다르게 한 것: 시간 상한 30 → 120초, 훅 실패를 성공으로(리뷰 반영).
