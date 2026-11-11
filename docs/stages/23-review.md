# 23단계 — 변경 검토

`docs/plan.md` 23 줄: pane 종류 '변경' · 파일별 diff · 줄 골라 되돌리기(+⌘Z · 되돌린 것 7일) · 체크한 파일만 커밋 · 커밋 전 검사 실패 · 대화 diff 카드 · 전체 보기 '± 변경' 칩에서 들어옴 (Review).
verify: e2e(임시 git 저장소) — 줄 되돌리기 → 파일 내용 · ⌘Z 로 복구 · 커밋 뒤 `git log` · 훅 실패 표시.
보드: Review(변경 검토). 브랜치 `stage-23-review`. 커밋은 23a git · 순수 모델 · main → 23b 화면 · 대화 카드 · e2e 로 나눈다.

plan-check: 서버 없음 — 앱은 일감 폴더의 로컬 git 저장소와 `<userData>/reverted/` 파일에만 쓴다. 원격(push · fetch)은 하지 않는다

## 0. 스파이크 결과 (2026-11-11)

| 미확인 (보드) | 돌려 본 것 | 결과 |
|---|---|---|
| 큰 저장소의 fs.watch 재귀 비용 · 놓치는 변경 | 이 저장소(파일 12,166개, node_modules 포함)에서 Electron(node) `fs.watch(dir, {recursive:true})` | 시작 0.2ms · rss +0.6MB(FSEvents). 최상위 · `node_modules/` 안 파일 만들기 · 지우기 이벤트 4개 모두 옴 → **거르기는 콜백에서**(`node_modules/` · `.git/` 버림, `.git/index` · `.git/HEAD` 만 받음). 놓침 대비로 창 포커스 · pane 보일 때도 다시 읽는다 |
| 고른 줄만 `git apply -R` 할 때 덩어리 가운데 줄 | 임시 저장소 `a b c d e f g → a B1 B2 c d E f g h` 에서 가운데 `-e +E` 만 고름 | **문맥 방식**: 고르지 않은 `+` 줄 → 문맥(공백), 고르지 않은 `-` 줄 → 뺌, 머리 줄 수 다시 셈 → `git apply -R` 이 정확히 `e` 만 되돌림 · 같은 패치 정방향 `git apply` 로 원래대로. 파일 끝 `+h` 만 · 끝 줄바꿈 없는 파일(`\ No newline at end of file`)도 확인. `--unidiff-zero`(문맥 0) 도 되지만 줄 번호가 어긋나면 엉뚱한 곳에 붙으므로 쓰지 않는다 |
| 커밋 훅 · 서명이 창 없이 물을 때 | 임시 저장소에 실패하는 pre-commit(stdout · stderr 둘 다 씀) · `-c commit.gpgsign=true -c gpg.program=/usr/bin/false` | 훅 출력은 stdout · stderr 둘 다 와서 둘을 합쳐 마지막 20줄. 서명 실패는 `error: gpg failed to sign the data` + 종료 코드 1. 서명 창(pinentry · 1Password)이 **기다리는 중인지는 git 이 알려 주지 않는다** → 저장소의 `commit.gpgsign` 이 켜져 있고 3초 넘게 걸리면 '서명을 기다려요 — 서명 창을 확인해 주세요' 로 바꿔 보인다. 이 Mac 은 전역 서명 설정이 없어 실제 pinentry 대기는 **미확인** |
| 터미널 git 과 index.lock 겹침 | 코드 읽기 | 상태 읽기는 `--no-optional-locks`(index 를 고쳐 쓰지 않음). 줄 되돌리기는 `git apply`(index 안 씀)라 lock 과 무관. 커밋 · 커밋 취소만 lock — stderr 에 `index.lock` 이 있으면 '터미널에서 다른 git 이 돌고 있어요' |
| worktree 의 기준 브랜치 | Task 에 cwd 만 있음 | 기억해 둘 칸을 더하지 않고, 지금 브랜치가 `main`/`master` 가 아니고 그 브랜치가 있으면 '`main` 과 다른 것' 탭(보기만, `git diff main...HEAD`). 기준 브랜치 기억은 하지 않음 |

## 1. 범위

### 이렇게 만든다 (보드 → 할 일)
| 보드 | 할 일 |
|---|---|
| 1 git 은 main 이, 볼 때만 | `src/main/review-git.ts` — `execFile('git', …)` 에 `LC_ALL=C` · `GIT_TERMINAL_PROMPT=0` · `GIT_OPTIONAL_LOCKS=0` · 시간 제한 15초(커밋은 120초). `status --porcelain=v2 -z --untracked-files=all` + `diff HEAD --no-color --no-ext-diff -U3`(새 파일은 파일을 읽어 `+` 줄로). pane 이 열리고 보일 때 · 창 포커스 · 폴더 감시(0.5초 모음) · 쓰기 뒤에만. 머리에 '방금 갱신 / 갱신 중' 점 |
| 2 diff 해석은 shared | `src/shared/review.ts` — `parseStatus` · `parseDiff` · `foldReason`(1MB · 5000줄 · 이진 → 접고 '그래도 보기') · 덩어리 사이 '··· n줄' 표시(펼치기는 하지 않음, 아래 '하지 않는 것') · 파일 100개 넘으면 폴더 보기로 시작(맨 위 폴더 하나로 접음) |
| 3 줄 되돌리기 = 역패치 + 7일 | `buildPatch(file, selected)`(문맥 방식) → `git apply --check -R` → `git apply -R`. 확인 없이 바로 · 알림 '줄 n개를 되돌렸어요 [되살리기 ⌘Z]'. 패치는 `<userData>/reverted/<시각>-<id>.json`(0600, 폴더 0700) 에 7일 — '되돌린 것' 목록에서 되살리기(정방향 `git apply`, `--check` 실패면 '그 뒤로 같은 줄이 또 바뀌어 되살릴 수 없어요') |
| 4 커밋은 체크한 파일만 · 막을 때만 경고 | 커밋 순간 `git add -A -- <체크한 파일>` → `git commit -F - -- <체크한 파일>`(다른 스테이징은 섞지 않음). 경고 두 가지: 갈래(worktree)가 아닌 저장소에서 `main`/`master` 에 바로 커밋 · 체크한 파일의 더해진 줄에 `redact` 가 걸림 → 단추 '그래도 커밋'. 상태: 쓰는 중 · 경고 · 검사 중(초) · 서명 기다림 · 검사 실패(마지막 20줄 · '대화에 고쳐 달라고 하기' · '다시 커밋') · 끝남. 빠진 파일이 있으면 'n개는 빠져 있어요' 한 줄 |
| 5 커밋 취소 · 다음 단계 | '커밋 취소' = `git reset --soft HEAD~1` — HEAD 가 그 커밋이고 `git branch -r --contains` 가 비었고 부모가 있을 때만 보임. '리뷰 중으로 옮기기' = 상태 이름에 '리뷰' 가 든 상태가 있으면 그 일감을 그 상태로(없으면 단추 없음) |
| 6 키보드 · ⌘P | j/k 파일 · n/p 덩어리 · ⇧↑↓ 줄 고르기 · ⌫ 고른 줄 되돌리기 · ⌥↩ 봤음 · ⌘↩ 커밋 · / 거르기 · Esc. ⌘P: '변경 보기'(⇧⌘G) · '변경 커밋'(커밋 칸으로) · '되돌린 것 보기' |
| 7 worktree 는 'main 과 다른 것' | 위 스파이크 — 보기만(되돌리기 · 커밋 막음) |
| ↔ 다른 보드 | 대화 도구 줄(Edit · Write · MultiEdit · NotebookEdit · Codex fileChange)에 'diff 열기 →' — 그 일감의 변경 pane 을 열고 그 파일로. diff 줄의 '✦ 대화에 묻기' · 검사 실패의 '대화에 고쳐 달라고 하기' = 같은 일감의 대화 pane 입력칸에 글을 넣는다(없으면 대화로 오른쪽 나누기). 전체 보기 '± 변경' 칩 · 이어받기 · CLI 는 그 화면이 아직 없어 하지 않음 |
| 빈 · 오류 | 바뀐 것 없음(마지막 커밋 해시 · 몇 분 전) · 저장소 아님('터미널에 git init 넣기') · git 없음('xcode-select --install 넣기' · 다시 찾기) · 병합 중(`.git/MERGE_HEAD` 또는 상태에 `u` 줄 — 줄 되돌리기 · 커밋 막음, 보기는 됨) |
| 정할 것(추천안) | pane 종류 '변경' · 스테이징 숨김(이미 add 한 것은 체크된 채로 — 체크는 기본 모두 켬) · 줄 · 덩어리는 확인 없이, '파일 전체 되돌리기…' · 새 파일 지우기만 확인 · '봤음' 은 pane 메모리(파일 diff 가 바뀌면 풀림) · 커밋 경고 두 가지 · git 라이브러리 없이 CLI · 폴더 감시는 열려 있을 때만 |

### 설계
| 파일 | 내용 |
|---|---|
| `src/shared/review.ts` (순수) | `parseStatus(z)` → `{branch, files[{path, kind:'M'|'A'|'D'|'R'|'U', staged}]}` · `parseDiff(text)` → `DiffFile[{path, oldPath?, binary, hunks[{header, oldStart, newStart, lines[{t:' '|'+'|'-', text, oldNo?, newNo?, noEol?}]}]}]` · `untrackedDiff(path, text)` · `buildPatch(file, sel)` · `wholePatch(file)` · `foldReason` · `fileSig`(봤음 풀림용) · `commitWarnings` · `folderGroups` · `liveReverted`(7일) · `filterFiles` |
| `src/main/review-git.ts` | `runGit` · `loadReview(dir, base)` · `applyPatch(root, patch, reverse)` · `commitFiles(root, files, msg, onPhase)` · `undoCommit(root, hash)` · `RevertStore`(`<userData>/reverted`) · `ReviewWatch`(pane 마다 fs.watch, 보일 때만) |
| `src/shared/ipc.ts` · preload `review` | `review:load(dir, base)` · `review:revert-lines(dir, path, sig, keys)` · `review:revert-file(dir, path, sig)` → 기록 id (패치는 main 이 만든다) · `review:restore(id)` · `review:reverted(root)` · `review:clear-reverted` · `review:commit(dir, paths, msg)` · `review:undo-commit(dir, hash)` · `review:watch(paneId, root|null)` · 이벤트 `review:changed(paneId)` · `review:open-file(root, path)`(편집기로 열기 = `open -t`, 저장소 안 경로만) — 커밋 단계 이벤트는 두지 않았다(결과 절) |
| `src/shared/types.ts` · `model.ts` | `Pane.kind = 'review'` · `review?: { file?: string }` · `openReviewPane(task, newId, file?)`(있으면 그 pane 으로, 없으면 오른쪽 나누기 · 탭이 없으면 새 탭) · `parsePane` |
| `src/renderer/ReviewPane.tsx` | 머리 · 목록 · diff · 커밋 칸 · 되돌린 것 · 빈 화면 · 키 |
| `src/renderer/ChatPane.tsx` | 도구 줄 아래 'diff 열기 →' · `draft` 받기(대화에 묻기) |

### 가린 사본이 닿는 곳 (rc2deda)
| 길 | 무엇이 가나 |
|---|---|
| 화면(diff 줄) | **원문** — 사용자가 고칠 코드를 보는 화면이라 가리지 않는다(화면 가리기 설정은 터미널 출력 몫). 대신 커밋 경고가 비밀값 줄을 짚는다 |
| `<userData>/reverted/*.json` | **원문 패치** — 되살리려면 원문이 필요. 0600 · 7일 뒤 지움 · 설정 › 개인정보 '되돌린 것 비우기' |
| 대화로 보내는 글(대화에 묻기 · 고쳐 달라고 하기) | 입력칸에 원문을 넣는다 — 대화 기록 파일로 갈 때는 21단계 `redactEvent` 가 가린다(이미 있는 길) |
| 훅 실패 출력 | 화면에만(디스크에 안 씀) |
| 커밋 메시지 | git 으로 원문(사용자가 쓴 글) |

### 칸 (plan-check · 계획 규칙)
- **결과를 모를 때**: git 이 시간 제한으로 죽거나 응답을 못 받으면(커밋 120초 · 그 밖 15초) 결과를 모르는 것으로 보고 → 화면은 '결과를 모르겠어요 — 다시 읽었어요' 알림 + 즉시 다시 읽기(실제 저장소 상태가 곧 답). 커밋은 다시 읽은 HEAD 가 바뀌었으면 끝남으로.
- **다시 시도**: 검사 실패 뒤 '다시 커밋' 은 그 순간의 체크 · 메시지로 처음부터(add → commit). 줄 되돌리기 실패(`--check` 실패 = 그 사이 파일이 바뀜) → 다시 읽고 '파일이 바뀌어 되돌리지 못했어요'.
- **이중 입력**: 커밋 · 되돌리기 · 되살리기는 실행 중 다시 누르기 막음(진행 중 표시 동안 단추 꺼짐 · ⌫ · ⌘↩ 무시). 같은 프레임 두 번 ⌫ 도 ref 로 막는다.
- **취소 · 닫기**: 커밋 중 pane 을 닫으면 main 의 git 은 끝까지 돌고(중간에 죽이면 index.lock 이 남는다) 결과는 알림으로. 되돌리기 알림의 ⌘Z 는 pane 이 닫혀도 되살린다(기록 id 로).
- **고른 뒤 나중에 실행(r4ee705)**: '파일 전체 되돌리기…' 확인 창은 연 순간의 패치를 떠 두고, 확인 때 `--check` 로 그 사이 바뀌었는지 본다. 되살리기는 기록 id 로 다시 찾는다.
- **늦게 도착하는 옛 응답**: 읽기마다 요청 번호. 쓰기(되돌리기 · 커밋)가 끝나면 번호를 올려 진행 중이던 옛 응답을 버린다.
- **부수 요청**: 폴더 감시 · 포커스 · 보일 때 다시 읽기는 한 번에 하나 — 진행 중이면 건너뛴 요청을 표시해 두고 앞 읽기가 끝난 뒤 한 번 다시 돈다. pane 이 안 보일 때(숨은 탭 · 숨은 일감)는 감시를 끄고 읽지 않는다.
- **처음 한 번만 읽는 값**: 브랜치 · 기준 브랜치 · worktree 여부 · `commit.gpgsign` · 병합 중은 읽을 때마다 다시 읽는다(처음 한 번 읽은 값으로 경고하지 않는다 — 낡지 않게).
- **앱 종료 4경로**: 감시는 창 닫기 · 새로 고침(renderer 가 다시 `watch`) · 렌더러 충돌(창 `destroyed` 에서 모두 닫음) · 앱 종료에서 닫는다. 진행 중인 git 은 자식 프로세스라 앱과 함께 끝날 수 있음 — 되돌린 것 기록은 **적용 전에** 쓰고 적용이 실패하면 지운다(앱이 그 사이 끝나면 기록만 남고, 되살리기의 `--check` 가 '되살릴 수 없어요' 로 막는다). 되돌리기 작업 도중 앱이 끝나 '적용됨' 표시가 없는 기록은 다시 열 때 목록이 `git apply --check`(정방향)로 확인해, 적용이 안 된 기록이면 '되살릴 것 없음' 으로 닫는다(목록에서 뺌). 커밋 도중 앱이 끝나도 git 이 남긴 상태가 곧 결과 — 다시 열 때 읽기로 끝난다.

## 3. 시험
단위
- `tests/unit/review.test.ts`: parseStatus(수정 · 새 · 지움 · 이름 바꿈 · 충돌 · 공백 · 한글 경로 -z) · parseDiff(덩어리 · 줄 번호 · 이진 · 끝 줄바꿈 없음 · 이름 바꿈) · buildPatch(가운데 줄 · `+` 만 · `-` 만 · 끝 줄바꿈 없음 · 고른 것 없음 → null) · foldReason · fileSig · commitWarnings · folderGroups · liveReverted(7일 경계) · filterFiles
- `tests/unit/review-git.test.ts`(임시 저장소에 실제 git): loadReview(바뀐 것 없음 · 저장소 아님 · 새 파일 · 병합 중) · 줄 되돌리기 → 파일 내용 · 되살리기 · 그 사이 바뀌면 되살리기 거절 · 파일 전체 · 새 파일 지우기/되살리기 · 커밋(체크한 파일만 · 다른 스테이징은 남음) · 훅 실패(마지막 20줄) · 커밋 취소(원격에 있으면 거절) · RevertStore 7일 · 0600 · 저장소 밖 경로 거절
- `tests/unit/model.test.ts`: openReviewPane(있으면 그 pane · 없으면 나누기 · 탭 없음) · parsePane 'review'
e2e `tests/e2e/review.spec.ts`(임시 git 저장소, 로컬 설정으로 서명 끔)
1. ⇧⌘G → 파일 목록 · diff · 줄 2개 골라 ⌫ → 파일 내용(fs) · 알림 ⌘Z → 원래대로 · 스크린샷
2. 되돌린 것 목록 → 되살리기 · 그 사이 같은 줄을 바꾸면 '되살릴 수 없어요'
3. 커밋: 파일 하나 체크 해제 → 메시지 → ⌘↩ → `git log` 에 체크한 파일만 · '빠져 있어요' 줄 · 커밋 취소
4. 훅 실패: pre-commit 이 실패 → '커밋 전 검사가 실패했어요' · 마지막 줄 · 아무것도 커밋 안 됨 · 대화에 고쳐 달라고 하기 → 대화 입력칸
5. 빈 화면: 저장소 아님 · 바뀐 것 없음 · 셸에서 파일을 바꾸면(폴더 감시) 목록에 나타남
6. 대화 diff 카드: 가짜 claude 가 Edit 도구 → 'diff 열기' → 변경 pane 의 그 파일
7. main 에 바로 커밋 경고 · 비밀값 경고 → '그래도 커밋'

## 4. 순서 → verify
1. review.ts 시험 → 구현 → vitest
2. review-git.ts 시험(임시 저장소) → 구현 → vitest
3. IPC · preload · model(pane 종류) → typecheck · 경계 · window.spec 허용 목록
4. ReviewPane · App 연결 · ChatPane 카드 · 메뉴/⌘P → e2e 7개 · 스크린샷을 직접 열어 보드와 대조 → 23a/23b 커밋
5. 변이(핵심 줄만): buildPatch 문맥 바꾸기 · 체크한 파일만(`-- files`) · 요청 번호 · 7일 · 원격 확인 · 저장소 밖 경로 · 경고 두 가지
6. 전체 검사 → `/code-review medium` → 고침 커밋 → 전체 검사 → 문서 → main 병합 → 회고

## 5. 하지 않는 것
- push · pull · merge · rebase · 브랜치 바꾸기 · 충돌 해결 화면 · blame · log 탐색 · 코드 편집(편집기로 열기만) · 여러 저장소(보드 그대로)
- '··· n줄 펼치기'(바뀌지 않은 줄 펼치기) — 표시만, 펼치지 않는다(`-U3` 뒤 전체 파일을 다시 읽어야 함)
- '✦ 메시지 제안'(AI 로 커밋 메시지) — 대화 연결이 24단계 지휘와 겹쳐 그때
- 전체 보기 '± 변경' 칩 · 이어받기 '바뀐 파일 n개' · CLI `taskminal diff --stat` — 그 화면 · 명령이 아직 없다(전체 보기는 design-gaps, CLI 는 24단계)
- worktree 기준 브랜치를 Task 에 기억하기

## 6. 결과 (2026-11-11)
- 시험: 단위 `review.test.ts` · `review-git.test.ts`(임시 저장소에 실제 git) · `model.test.ts` 변경 pane, e2e `review.spec.ts` 7개(임시 저장소 · 로컬 설정으로 서명 끔). 스크린샷 `test-results/review-*.png` 7장을 열어 보드와 대조했다.
- 변이 11개 모두 잡음(문맥 바꾸기 · 고른 줄 없는 덩어리 · 줄 수 다시 셈 · worktree 면 main 경고 없음 · 지운 줄 비밀값 · 7일 · 원격 커밋 취소 거절 · safeRel · `--only -- 경로` · 적용 안 된 기록 정리 · 본 diff 표지). safeRel 은 처음에 못 잡았다 — 줄 되돌리기 시험은 '바뀐 파일 목록' 검사가 먼저 막아 safeRel 을 따로 보지 않았다. 편집기로 열기는 safeRel 만 보므로 직접 시험을 더했다.
- 요청 번호(옛 응답 버리기)는 renderer 라 단위 변이 대상이 아니다 — e2e 의 쓰기 뒤 다시 읽기로만 본다.

### 리뷰(`/code-review medium`) 10건 — 9건 고침
- 인덱스에 올라간(`git add` 한) 파일을 작업 폴더만 되돌려 다음 커밋에 그대로 들어가던 것 → `git apply -R --index` 로 인덱스도 함께, 되살릴 때도 같이. 일부만 add 한 파일은 이유를 알리고 하지 않는다.
- 적용이 시간 초과로 끝나면 기록이 '적용 안 됨' 으로 남아 1분 뒤 지워지던 것 → 정방향 `--check` 로 실제로 됐는지 가려 됐으면 '적용됨' 으로.
- 새 파일 링크를 따라가 폴더 링크 하나에 읽기 전체가 깨지고, 저장소 밖 파일 글을 보이던 것 → `lstat` 으로 링크는 따라가지 않고(이진처럼 접음), 읽다 사라진 파일은 그 파일만 접는다.
- 대화 카드의 경로(대화 폴더 기준)와 변경 pane 의 경로(저장소 뿌리 기준)가 하위 폴더 일감에서 달라 엉뚱한 파일이 열리던 것 → `resolveReviewPath`.
- 커밋이 본 diff 와 같은지 보지 않아 그 사이 에이전트가 고친 내용을 보지 않은 채 커밋하던 것 → 체크한 파일마다 표지를 보내 다르면 'changed'.
- 대화 입력칸 글 · 변경 pane 요청을 App 이 지우지 않아 pane 이 다시 그려지면 같은 글이 또 붙던 것 → 받으면 App 에 알려 지운다.
- 갈래(linked worktree)는 index · HEAD 가 본 저장소의 `.git/worktrees/<이름>/` 에 있어 터미널의 `git add` · `commit` 을 못 듣던 것 → 그 폴더를 얕게 함께 감시.
- maxBuffer 로 죽은 git 을 '시간 초과(결과 모름)' 로 세던 것 → `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 는 실패로.
- 편집기로 열기가 renderer 의 root 를 믿던 것 → main 이 `rev-parse --show-toplevel` 이 root 와 같고 링크 아닌 보통 파일일 때만 연다(`openTarget`).
- 하지 않음: 되돌리기 · 커밋 때 파일 하나를 보려고 저장소 전체를 다시 읽는 비용 — 표지를 같은 함수(`loadReview`)로 만들어야 화면의 표지와 맞는다. 큰 저장소에서 느리면 그때 그 파일만 읽는 길을 만든다.
- 고친 9건 중 8건은 옛 동작으로 되돌린 변이 9개로 시험이 잡는 것을 봤다. 입력칸 글이 다시 붙던 것(renderer)과 maxBuffer 구분은 시험이 없다.

### 계획과 다르게 한 것
- 커밋을 23a(git · 모델 · main) · 23b(화면 · 카드 · e2e) 둘로 나누지 않고 하나로 했다 — 화면과 IPC 를 함께 고치며 시험해 중간 상태가 따로 돌지 않았다.
- 커밋: 계획은 `git add -A -- <체크한 파일>` → `git commit -F - -- <체크한 파일>` 였으나, 새 파일만 `git add` 하고 `git commit -F - --only -- <체크한 파일>` 로 했다 — `--only` 가 이미 add 한 다른 파일을 섞지 않음을 명시하고, 실패하면 add 한 새 파일만 `git reset` 으로 뺀다.
- 커밋 단계 이벤트(계획의 commit-phase)는 두지 않았다 — 커밋은 invoke 하나로 끝나고, '검사 중 n초' · '서명을 기다려요'(서명 켜짐 + 3초 넘음)는 renderer 의 시계로 보인다.
- 편집기로 열기는 `shell.openPath` 가 아니라 `/usr/bin/open -t` — openPath 는 `.command` · `.app` 을 실행한다.
- `--no-renames` 로 읽어 이름 바꿈은 지움 + 새 파일 두 줄로 보인다. 그래서 parseDiff '이름 바꿈' 시험은 없다(parseStatus 의 `2 R` 줄 시험은 있음).
- '리뷰 중으로 옮기기' 단추는 이름에 '리뷰' 가 든 상태가 있을 때만 — 기본 상태(진행 중 · 대기 · 완료)에는 없어 기본 설정에선 보이지 않는다(계획대로지만 눈에 안 띄는 점을 적어 둠).
- 새 파일(아직 git 이 모르는 파일)의 줄 되돌리기도 허용한다(그 줄을 파일에서 지움) — 계획에 따로 적지 않았던 경우.
- 대화 diff 카드에는 +/− 수를 넣지 않았다 — 도구 줄에는 경로만 있고, 수를 알려면 git 을 다시 읽어야 한다.
