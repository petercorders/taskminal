# 67 — 병합된 worktree 를 알아서 찾아 정리

범위 `docs/ideas/next-five-v6.md` '3 의 첫 수직 기능'. 브랜치 `feat/67-merged-worktree-cleanup`. 상태: 단위까지 확인 · **e2e 미실행(사용자 지시 — 앱을 띄우지 않음)**.
plan-check: 서버 없음 — 로컬 git 만(네트워크 · gh 호출 없음). 지우기는 39 의 `git worktree remove`(force 없음) 그대로.
검증 강도: 기본 — 되돌릴 수 없는 삭제(폴더)가 있다.

## 무엇
- worktree 패널 카드에 '병합됨' · '병합 모름' 칩(모름 · 새 브랜치는 이유 한 줄), 연결 일감의 사이드바 줄 · 전체 보기 카드에는 '병합됨' 칩(리뷰 뒤 — 아래 '계획과 다르게 한 것').
- '병합된 것 정리… (N)' — 후보 미리보기(브랜치 · 경로 · 마지막 커밋 · HEAD · 변경 없음 · 함께 보관할 일감) · 병합됐지만 빠진 것과 이유 · 모름/새 브랜치 개수 → 고른 것만 확인 대화상자 → 줄마다 결과(정리함 · 남음 · 확인 못 함 · 안 함).
- 연결 일감은 지우지 않고 **보관**(25 보관함, 되살리기 가능 — 폴더가 없으면 셸은 홈에서 열린다, `pty-manager.ts` `resolveCwd`). 알림 · 자동 삭제 없음.

## 설계
| 칸 | 정한 것 |
|---|---|
| 기준 브랜치 | `refs/remotes/origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`, 처음 풀리는 커밋. 없으면 '모름'. fetch 하지 않는다 — 낡은 원격 기준은 조상 검사가 실패하는 쪽이라 '모름' 이 늘 뿐이다(시험: origin/HEAD → develop 이 낡았으면 로컬 main 에 병합돼도 모름) |
| 병합 판정 `classifyMerge` | 기본 · bare · 기준 브랜치 자신은 표시 없음. 기준 없음 · 분리된 HEAD · 비교 실패 · **조상 아님(진행 중 또는 squash · rebase)** · 브랜치 reflog 의 첫 줄이 `branch: Created from` 이 아님 → 모름. 조상이고 HEAD == 만든 지점, 또는 reflog 에 이 브랜치에서 커밋을 만든 줄(`commit…` · `cherry-pick:` · `revert:` · `am:` · `merge …: Merge made by`, git 2.47.1 실측)이 없음(기준을 `Fast-forward` 로 받아 오기만 함) → fresh(새 브랜치, 병합됨 아님). 그 밖의 조상 → 병합됨 |
| PR 상태 | 33 `findPr` 은 열린 PR 만 조회하고 저장하지 않으며 47 은 `prUrl` 만 저장한다 — 재사용할 PR 상태가 없어 squash · rebase 는 '병합 모름'. 패널을 열 때 네트워크 없음 |
| 후보 `cleanupPreview` | 병합됨 + `cleanable`('사용 중' 만 빼면 정리 가능 — 변경 · 미추적 · 무시 파일 · 잠금 · 기본 · bare · prunable · 중첩 · 상태 미확인이 없음) + 패널을 연 폴더 아님(`current`) + 연결 일감이 모두 그 폴더에 일감 폴더를 둔 것(`own`) + 연결 일감에 도는 명령 없음 + 연결 일감 없이 사용 중이 아님 |
| 확인 흐름 `cleanupStep` | idle → preview(고르기) → asking(확인을 **연 순간의 사본**) → confirm 일 때만 run 한 번. 고르기 · 취소 · 닫기 · asking 아닌 confirm 은 실행하지 않는다 |
| 실행 `runCleanup` | 확인 직후 목록을 다시 읽어 path · commonDir · HEAD · branch · 연결 일감이 같은 것만 남김 → **줄마다** 그 줄의 일감만 보관(`App.archiveForCleanup`: 셸 끄기 → 상태를 main 에 먼저 보냄)한 직후 `worktrees:clean` 으로 그 줄만 → 결과를 모르면 뒤 줄은 보관도 안 하고 멈춤 · 응답을 못 받으면 '확인 못 함' |
| main `clean()` | 차례로. 줄마다 등록 목록에서 확인한 대상을 다시 찾고(`find`) 병합됨을 다시 판정 → 연결 일감이 있으면 보관이 끈 셸이 끝나기를 최대 3초(200ms 마다) → 39 `remove()`(사용 경로만 `usedFor(taskIds)`) . 실행 전에 막히면 unchanged, 결과 모름이면 남은 줄은 skipped |
| 사용 경로 `usedTaskPaths` | 이 정리를 위해 **보관 상태인** 그 일감들의 저장된 폴더만 뺀다. 보관 안 된 일감(id 를 받아도) · 다른 보관 일감 · 열리는 중 · 실제 셸 cwd(lsof) · 저장소 뿌리는 39 그대로 막는다 |
| revision 경쟁 | 39 `remove` 는 사용 경로를 다시 보는 동안 앱 상태가 바뀌면 막는다. main 이 상태 저장마다 revision 을 올려 이름 · 선택 같은 저장도 정리를 막았다 → `worktreeUseKey`(로컬 일감 id · 보관 · 폴더 · pane 폴더)가 바뀔 때만 올린다(`index.ts`). 사용 경로는 이 값에서만 나오므로 39 의 보호 범위는 같다 |
| 연결 일감 칩 | 패널이 목록을 읽을 때 `mergeBadges` 로 일감 폴더가 그 worktree 안인 일감의 **병합됨만** (그때 브랜치와) App 메모리에. 15c 의 지금 브랜치가 다르면 숨김(`shownBadge`). 같은 브랜치에 새 커밋이 생겨도 패널을 다시 읽을 때까지 남는다 — 칩 title 에 '워크트리 패널에서 읽은 때 기준', 저장하지 않고 정리는 칩을 근거로 하지 않는다(늘 다시 읽고 판정) |

## 칸 (결과 모름 · 다시 시도 · 이중 입력 · 취소 · 그 사이 바뀜)
- 결과를 모를 때: 줄마다 `git worktree remove` 뒤 등록 · 폴더 실조회(39 `reconcileRemove`). 모름이면 '확인 못 함' · 남은 줄은 멈춤. IPC 응답 유실이면 줄마다 '확인 못 함' 과 목록 다시 읽기. 보관한 일감은 보고에 이름과 '보관함에서 되살리기'.
- 다시 시도: 요청 번호 없음 — 이미 지운 대상은 다시 찾기에서 '바뀌었어요' 로 안 한다. 셸이 3초 안에 안 끝나 남은 줄은 다시 열면 일감이 이미 보관돼 바로 정리할 수 있다.
- 이중 입력: 패널 `lock`(39 `write`) · reducer 의 asking 에서 confirm 한 번 · main 저장소 잠금(`locked`)으로 줄마다 직렬.
- 취소 · 닫기: 미리보기 닫기 · 확인 취소는 git 을 부르지 않는다. 실행 중 패널을 닫아도 main 은 끝까지 하고 다시 열면 목록이 결과를 보여 준다. 늦은 결과는 패널 세대로 버린다. 포커스는 취소 → '고른 N개 정리…', 닫기 · 결과 닫기 → '병합된 것 정리…'(꺼져 있으면 패널).
- 그 사이 대상이 바뀜(학습 규칙 r4ee705): 사본 + 다시 읽기 + main 잠금 안의 `find`(path · commonDir · HEAD · branch). 시험: 확인 뒤 HEAD 가 바뀌면 안 함.
- 앱 종료 4경로: 이미 시작한 `git worktree remove` 는 끝나거나 죽고 다음 목록 읽기가 실제를 보인다. 보관은 상태 저장에 갔으면 남고, 아니면 일감이 사용 중이라 지우기도 안 된다. 새 저장 파일 없음.

## 코드와 시험
`src/shared/worktree-cleanup.ts`(판정 · 후보 · 흐름 · 실행 순서 · 사용 경로) · `src/shared/worktree-management.ts`(`MergeInfo` · `WorktreeCleanItem` · `WORKTREE_USED_REASON`) · `src/main/worktree-management.ts`(`mergeBase` · `mergeOf` · `cleanable` · `current` · `clean`, `remove` 의 사용 경로 인자) · `src/main/worktree-ipc.ts`(`worktrees:clean`, 연결 일감 `own` · `archived`) · `src/main/index.ts`(`worktreeUseKey` 로 revision) · `src/preload/index.ts` · `src/renderer/WorktreePanel.tsx` · `src/renderer/App.tsx`(`archiveForCleanup` · `stopPanes` · 칩) · `src/renderer/Sidebar.tsx` · `src/renderer/Overview.tsx` · CSS 2곳.

단위 `tests/unit/worktree-cleanup.test.ts` 23개 — 판정(순수 3 · 실제 git 4: merge 커밋 · ff 병합됨, squash 모름, 커밋 없는 새 worktree · 기준을 받아 오기만 한 worktree fresh, 기준 없음 모름, origin/HEAD 먼저), 후보(실제 git 변경 · 미추적 제외 · 기본 제외, 순수 3), 흐름 2(확인 없이 안 함 · 연 순간 사본으로 한 번), 실행 순서 3(바뀐 줄 안 함 · 모름 뒤 보관도 안 함 · 응답 유실), revision 기준 1, 사용 경로 1, main clean 실제 git 5(병합된 것만 지우고 브랜치 남김 · HEAD 바뀌면 안 함 · 병합 아닌 것 · 기본은 요청이 와도 안 함 · 셸 기다림 / 끝까지 쓰이면 남김 · 모름 뒤 멈춤).

## 결과
- 단계 끝 검사 `FULL_CHECK_NO_E2E=1 full-check.sh` **종료 4**(e2e 미실행): typecheck · 경계 · 단위 **1,617**(+23) 통과(리뷰 고침 뒤).
- 변이 10개(핵심 줄만, batch 1분 15초): 처음 9 잡음 · 1 못 잡음 — '확인 연 순간 사본 안 뜸' 은 시험이 확인 **뒤에** 값을 바꿔 사본 여부를 못 갈랐다. 확인 열기와 confirm **사이에** 바꾸도록 고쳐 다시 돌려 잡음 → 10/10. 잡은 것: fresh 판정 · 조상 검사(squash) · origin/HEAD 우선 · cleanable 이 변경 무시 · pane 만 둔 다른 일감 · 사본 · 정리 직전 병합 재판정 · 모름 뒤 멈춤 · 셸 기다림 · 보관 안 된 일감 제외 안 함. 리뷰 고침 변이 4개(받아 오기만 한 브랜치 fresh · reflog 커밋 줄 · renderer 모름 뒤 멈춤 · revision 기준의 보관) 모두 잡음 — 합계 14/14.
- UI/UX(코드로만 — 화면 미확인): 확인 취소 · 미리보기 닫기 뒤 포커스가 아직 꺼진 단추로 가던 것을 39 의 꼴(다시 그린 뒤 켜진 단추, 아니면 패널)로 고침 · 결과 닫기 뒤 포커스 복귀 추가. 체크박스는 legend 있는 fieldset 안 label, 칩은 글자로(색만이 아님), 줄은 `overflow-wrap: anywhere` · flex-wrap.
- 리뷰: 아래 '리뷰' 절.

## 계획과 다르게 한 것
- v6 의 'squash 저장소는 PR 상태' 는 하지 않았다 — 33 · 47 에 저장된 PR 상태가 없어(재사용할 조회 결과 없음) 지시서대로 '병합 모름'. gh 로 병합된 PR 을 묻는 단추는 다음 후보.
- 계획의 'main clean(실제 git): 보관 안 된 연결 일감이면 사용 중이라 안 함 / 보관한 그 일감만 빼면 지움' 은 한 시험으로 잇지 않았다 — 빼는 규칙은 `usedTaskPaths` 순수 시험, 사용 경로가 남으면 막는 것은 main clean 실제 git 시험으로 나눠 봤고, 둘을 잇는 IPC 접착(`worktree-ipc.ts`)은 Electron 이라 e2e 목록에.
- 계획에 없던 것: 정리 결과 닫기 · 확인 취소 · 미리보기 닫기 뒤 포커스(위 UI/UX).
- 리뷰 뒤 바꾼 것(계획 값 → 한 것): ① 병합됨 = '조상 + HEAD ≠ 만든 지점' → '+ reflog 에 이 브랜치의 커밋 줄' (계획에 '알려진 한계' 로 적었던 받아 오기만 한 브랜치를 고침). ② 연결 일감 카드 = '병합됨 · 병합 모름' → '병합됨' 만 — 조상이 아닌 진행 중 브랜치가 모두 '병합 모름' 이라 카드마다 붙는 소음이었다(모름과 이유는 패널 카드에 그대로). 지시서 범위의 '연결 일감 카드에 병합 모름' 과 다르다. ③ 보관 = '고른 것 모두 먼저' → '줄마다 그 줄 직전' (앞 줄 결과를 모르면 뒤 줄 일감을 보관하지 않게). ④ main revision = '상태 저장마다' → '일감 · pane 폴더 · 보관이 바뀔 때만'(39 동작 변경, `sentRef` 는 지움).

## 돌려야 할 e2e (앱을 띄우지 않아 미실행)
1. 임시 git + 병합된 worktree 2개(하나는 연결 일감) → 패널 '병합된 것 정리… (2)' → 고르기 → 확인 → 결과 '정리함', 폴더 없음 · 브랜치 남음 · 연결 일감이 보관함에.
2. 확인 취소 → git 호출 없음 · 포커스 '고른 N개 정리…'. 미리보기 닫기 · 결과 닫기 → 포커스 '병합된 것 정리…'.
3. 확인 대화상자를 연 뒤 그 worktree 에 커밋 → 확인 → '안 함'(다시 읽기에서 빠짐) 또는 main 의 '바뀌었어요'.
4. 연결 일감의 셸이 살아 있는 채 정리 → 보관이 셸을 끄고 3초 안에 정리됨. 명령이 도는 일감은 후보에서 빠짐.
5. 상태 순서: `archiveForCleanup` 의 먼저 보내기 뒤 main 이 보관을 보고 지움(IPC send · invoke 순서 가정). 정리 중 일감 이름 바꾸기 · 선택 같은 저장이 있어도 정리됨(revision 이 `worktreeUseKey` 로만 오름) · 정리 중 같은 일감을 되살리면 막힘.
6. 읽기 전용 상태에서 정리 → 보관 안 함 · 연결 일감 있는 줄은 '안 함'.
7. 사이드바 · 전체 보기 칩: 패널을 읽은 뒤 '병합됨', 그 일감에서 브랜치를 바꾸면 사라짐.
8. 좁은 창(200px 사이드바) · 라이트/다크 · 200% 에서 미리보기 줄 넘침 · 체크박스 정렬 · 긴 경로.
9. 39 `tests/e2e/worktrees.spec.ts` 전체 — `remove` 의 사용 경로 인자 · `inspect` 의 `cleanable` · 사용 중 이유 상수 · revision 을 올리는 조건을 바꿨다. 25 보관 e2e(`archive` 의 셸 끄기를 `stopPanes` 로 옮김).

## 리뷰

`code-review` high(브랜치 전체, 코드 읽기로만) 10건 — 고침은 별도 커밋.

| # | 지적 | 처리 |
|---|---|---|
| 1 | 기준을 ff 로 받아 오기만 한 브랜치가 병합됨 | 고침 — reflog 의 커밋 줄이 있어야 병합됨(위 ①). 실제 git 시험 · 변이 2 |
| 2 | 진행 중 브랜치마다 카드에 '병합 모름' | 고침 — 카드에는 병합됨만(위 ②) |
| 3 | 보관(셸 끔) 뒤 main 이 막으면 일감만 보관되고 worktree 는 남음 | 줄였음 — 줄마다 직전 보관 · 모름이면 뒤 줄 보관 안 함(위 ③) · 확인 직후 다시 읽기. 남는 경우(3초 넘게 사는 셸 · lsof 실패 · 병합 재판정 뒤집힘)는 보고에 보관한 일감과 '보관함에서 되살리기' — 보관은 되돌릴 수 있다 |
| 4 | 상태 저장마다 revision 이 올라 정리가 막힘 | 고침 — `worktreeUseKey`(위 ④). 시험 · 변이 1 |
| 5 | 같은 브랜치에 새 커밋이 생겨도 카드의 병합됨이 남음 | 남김 — 15c 브랜치 읽기는 HEAD 커밋을 모른다(파일 읽기만, 주기마다 프로세스를 띄우지 않는 설계). 칩 title 에 '패널에서 읽은 때 기준', 정리는 늘 다시 읽고 판정 |
| 6 | reflog 전체를 읽음 | 남김 — 커밋 줄 검사에 전체가 필요. 조상인 브랜치만 읽고, 8MB 를 넘으면 '모름'(안전한 쪽) |
| 7 | 줄마다 기준을 다시 풂 | 고침 — `clean()` 한 번에 한 번 |
| 8 | 보관의 셸 끄기가 두 벌 | 고침 — `stopPanes` |
| 9 | 대상 비교 함수 세 벌 | 고침 — `sameTarget` 을 shared 에서 내보내 main · 패널 · 정리가 같이 씀 |
| 10 | 전체 보기 칩이 즉시 실행 함수 · CSS 없음 | 고침 — `mergeChip` · `.overview-merge.merged` |

