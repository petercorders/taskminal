# 70 — 저장소째 옮겨 오기

범위 `docs/ideas/next-five-v6.md` 5번(수요 근거 약함 — '판정 보류' 를 사용자가 알고 진행 지시)의 첫 수직 기능만. 브랜치 `feat/70-import-repo-worktrees`. 상태: 단위까지 확인 · **e2e 미실행(사용자 지시 — 앱을 띄우지 않음)**.
plan-check: 서버 없음 — 로컬 git 조회(읽기만)와 로컬 상태(state.json) 쓰기만. 원격 · 네트워크 없음.
검증 강도: 기본 — 여러 일감을 한꺼번에 만드는 쓰기와 저장 형식(일감 칸 하나) 변경이 있다.

## 무엇
- 새 일감 대화상자(로컬일 때 아래 줄 왼쪽) · 워크트리 패널에 '저장소째 가져오기…'. 새 일감에서는 main 의 폴더 고르기 대화상자, 워크트리 패널에서는 그 일감 폴더의 저장소.
- 미리보기: worktree 마다 브랜치(분리된 HEAD 면 폴더 이름) · 경로 · 기본 · 잠김 · 병합됨/병합 모름(67) · **이미 일감 있음**(39 신원 검사) · 가져올 수 없는 이유 · 이 폴더의 최근 Claude · Codex 세션. 기본 고름 = 가져올 수 있고 · 일감 없고 · 병합됨 아님.
- '고른 N개 가져오기' → 다시 읽고 → 한 동작으로 일감 + 저장소 이름 묶음 → 결과(만든 것 · 건너뛴 것과 이유). 가져온 일감 머리에 '이 폴더에서 하던 세션' 띠 — 누를 때만 53 의 이어 하기(대화 · 터미널), 닫기. **자동으로 시작하지 않는다.**
- 범위 밖: 여러 저장소 한꺼번에 · 원격 저장소 · 자동 주기 가져오기 · worktree 만들기 · 다른 도구(Orca 등)의 내부 파일 읽기.

## 설계
| 칸 | 정한 것 |
|---|---|
| 발견 | main 39 `WorktreeManagement.list(root, [])` 그대로 — `git worktree list --porcelain -z`(`parseWorktrees`) · 폴더 확인 · 상태 · 67 병합 판정. git 만 |
| 가져올 수 있나 | 39 `open()` 의 조건을 `openable(entry)`(`src/shared/worktree-management.ts`)로 빼 둘이 같이 쓴다 — `canOpen && !bare && !prunable && 모르는 속성 없음`. 잠김은 표시만, 분리된 HEAD 는 폴더 이름. 막힌 줄은 이유를 보이고 고를 수 없다 |
| 이미 일감 있음 | 39 `worktrees:open` 처리기 안의 신원 검사를 `taskFolders`(`src/main/repo-import.ts`)로 빼 39 열기와 70 미리보기가 같이 쓴다 — 보관 안 된 로컬 일감의 `realpath(cwd)`, realpath 를 기다린 뒤 지금 상태에서 같은 cwd · 보관 안 됨을 다시 본다. 69 위임은 새 폴더를 만들어 이 검사 대상이 아님(코드 확인) |
| 묶음 | 저장소 이름 = 기본 worktree 폴더 이름(bare 면 `.git` 뺀 이름). 같은 이름(공백 · 대소문자 무시) 묶음이 비었거나 그 묶음의 일감(보관 포함)이 모두 이 저장소의 **어느** worktree 안이면 재사용, 아니면 `이름 (2)` · `(3)` … 처음으로 없거나 이 저장소 것인 이름. 일감을 하나도 안 만들면 묶음도 안 만든다 (`importGroup`) |
| 일감 | 39 열기와 같은 값(템플릿 없음 · 상태 첫째 · 색 없음 · 설정의 새 일감 시작). reducer `task/import` 한 동작(`applyImport`) — 묶음 + 일감 + 첫 일감 선택, 같은 cwd 의 보관 안 된 로컬 일감이 있으면 다시 거름. 저장 한 번 · 67 `worktreeUseKey` revision 한 번(39 정리의 사용 검사 규칙과 맞음 — 이름 · 후보 지우기는 revision 을 올리지 않는다, 시험) |
| 세션 후보 | main 이 53 `AgentSessions.list()`(15초 한도 — 넘거나 실패하면 '세션 기록을 읽지 못했어요' 와 세션 없이) → 세션 cwd 를 realpath → **가장 깊은** 등록 worktree 에 배정(`assignSessions`: 같은 폴더 · 하위 폴더만, `/x/app` 과 `/x/app-2` 는 다름, 안쪽 worktree 세션은 안쪽만) → 에이전트마다 최신 하나. 일감에 `sessionHints`(agent · id · 가린 요약 160자 · 시각, 에이전트마다 하나) — 저장 파일 검증 `parseSessionHints` 는 id 를 UUID 모양만(터미널 명령에 들어간다) |
| 띠 | `SessionHintBand` — 로고 · 에이전트 · 요약 · 상대 시각 · '대화로 이어 하기' · '터미널로' · '닫기'. 53 `resumeAgentSession` 그대로(이미 열린 대화면 그리로 · main 이 id 로 다시 찾음 · 15초). 성공하면 그 후보만 지우고(`task/hints-drop`), 실패하면 오류 글자와 후보 그대로 |
| 권한 | `worktrees:importPick` — main 이 폴더 고르기 대화상자를 열고 고른 폴더의 realpath 를 `ImportRoots`(최근 20개)에. `worktrees:importPreview(root)` — 그 목록에 있거나(별칭 경로도 realpath 로) 지금 로컬 일감 폴더일 때만(39 `root()` 와 같은 꼴). renderer 는 임의 경로를 읽게 할 수 없다 |
| preload | `window.taskminal.repoImport.{pick, preview}`(`RepoImportApi`) — 39 `WorktreeApi` 와 따로 둬 기존 가짜 구현이 그대로 |

## 칸 (결과 모름 · 다시 시도 · 이중 입력 · 취소 · 그 사이 바뀜)
- 결과를 모를 때: main 은 읽기만 한다. 누를 때 다시 읽기가 실패 · 응답 유실이면 **아무 일감도 만들지 않고** '다시 확인하지 못해 아무 일감도 만들지 않았어요 — …' 와 같은 단추로 다시(다시 읽기부터). 일감 만들기는 renderer 의 한 동작이라 결과가 정해진다(시험).
- 다시 시도: 요청 번호 없음 — 같은 고름으로 다시 하면 이미 만든 폴더는 '이미 일감이 있어요' 로 건너뛴다(시험: 두 번째는 0개).
- 이중 입력: 대화상자 `lock` + 단추 끔 · `task/import` 가 같은 cwd 를 다시 거름(겹친 두 동작도 한 번, 시험).
- 취소 · 닫기: 고르기 취소 → 보던 미리보기로, 없으면 닫힘. 읽는 중 · 가져오는 중에 닫으면 세대가 바뀌어 늦은 답을 버리고 **만들지 않는다**(`runImport` 의 `alive`, 시험). 끝난 뒤 닫기 → 워크트리 패널에서 열었으면 그 단추(가져온 일감으로 옮겨 패널이 숨었으면 터미널).
- 그 사이 바뀜(학습 규칙 r4ee705): 누른 순간 고른 줄의 사본(경로 · commonDir) → 다시 읽기 → `importPlan`: 다시 읽은 목록에 없음 · commonDir 다름 → '미리보기 뒤 사라졌어요', 이제 막힘(폴더를 지워 prunable) → '미리보기 뒤 바뀌었어요 — …', main 신원 검사 · renderer 지금 상태의 같은 폴더(`~` 편 것) 일감 → '이미 일감이 있어요'. 이름 · 세션 · 묶음은 다시 읽은 값과 지금 상태로(시험: 실제 git 에서 미리보기 뒤 폴더를 지우면 만들지 않음).
- 옛 응답 · StrictMode: 읽기 · 고르기 · 닫기마다 세대를 올리고, 처음 읽기(고르기)는 `started` 로 한 번 — 개발 모드의 두 번 실행에도 고르기 대화상자는 하나.
- 앱 종료 4경로: main 은 git 조회 · 세션 읽기만 해 남는 것 없음. 일감은 한 동작이라 저장에 갔으면 모두, 아니면 하나도 없음. 셸은 탭을 볼 때 뜬다(본 적 없는 가져온 일감은 셸 없음, `seenTabs`).

## 코드와 시험
- `src/shared/repo-import.ts`(줄 · 세션 배정 · 묶음 · 계획 · 일감 · reducer 본체 · `runImport`) · `src/shared/worktree-management.ts`(`openable`) · `src/shared/types.ts`(`SessionHint` · `Task.sessionHints`) · `src/shared/model.ts`(`parseSessionHints`) · `src/shared/ipc.ts`(`worktrees:importPick` · `worktrees:importPreview`)
- `src/main/repo-import.ts`(`taskFolders` · `ImportRoots` · `buildImportPreview`) · `src/main/worktree-ipc.ts`(39 열기가 `taskFolders` 를 씀 · 처리기 둘) · `src/main/worktree-management.ts`(`open` 이 `openable`) · `src/main/workspace-ipc.ts`(`agentSessions` 를 돌려줌) · `src/main/index.ts`
- `src/preload/index.ts` · `src/preload/api.d.ts` · `tests/preload-surface.ts`
- `src/renderer/ImportRepoDialog.tsx` · `src/renderer/repo-import.css` · `src/renderer/SessionHintBand.tsx` · `src/renderer/NewTaskDialog.tsx` · `src/renderer/WorktreePanel.tsx` · `src/renderer/store.ts`(`task/import` · `task/hints-drop`) · `src/renderer/App.tsx` · `src/renderer/styles.css`
- 단위 `tests/unit/repo-import.test.ts` 23개 — 줄 분류(순수: bare · prunable · 잠김 · 분리된 HEAD · 모르는 속성 · 상태 미확인 / 실제 git: 잠근 worktree · 폴더 지운 worktree · `--detach`), 신원(링크 · `~` · 보관 · 원격 · 기다리는 사이 보관 · 미리보기의 '이미 일감 있음'), 세션(그 폴더 · 하위 · 형제 · 안쪽 worktree · 에이전트마다 최신 · 실제 git + 53 기록 읽기로 링크 cwd · 읽기 실패 · 한도), 계획(사라짐 · 막힘 · 일감 있음 · 지금 상태 · commonDir 다름 · 실제 git 폴더 지움), 실행(다시 읽기 실패 · 닫힘 · 다시 하면 0개), 묶음(새 · 빈 것 재사용 · 이 저장소 것 재사용 · (2) · (3) · 다시 가져오기는 같은 묶음), reducer(한 동작 · 겹친 동작 · revision 기준), 저장 검증, 권한.

## 결과
- 단계 끝 검사 `FULL_CHECK_NO_E2E=1 … full-check.sh` **종료 4**(e2e 미실행): typecheck · 경계 · 단위 **1,701**(137 파일) 통과.
- 변이 10개(핵심 줄만, batch 47초): 8 잡음 · 1 판정 불가 · 1 못 잡음 → 판정 불가('미리보기 뒤 막힘' 을 `false &&` 로 끈 꼴이 타입 좁히기를 깨 컴파일 오류)는 `=== 'never'` 꼴로 다시 돌려 잡음. 못 잡음('보관 일감 제외' 를 먼저 거르는 줄)은 **중복된 거르기** — 뒤의 '지금 상태에서 다시 보기' 가 같은 일감을 거른다. 그 뒤 줄을 변이해 잡음(기다리는 사이 보관 시험) → 10곳 모두 시험이 지킨다. 잡은 것: 가장 깊은 worktree · 형제 폴더 경계 · 미리보기 뒤 막힘 · 지금 상태의 같은 폴더 일감 · 남의 일감 묶음 → (2) · 묶음을 저장소 모든 경로로 · 닫히면 안 만듦 · 기다리는 사이 보관 · 고른 폴더만 미리보기 · 세션 id UUID 만.
- 구현 중 스스로 찾아 고친 것(커밋 전): 다시 가져오기 때 묶음을 만들 줄로만 정해 같은 저장소인데 `이름 (2)` 를 만들던 것(시험 추가) · 다시 읽기 · 가져오기가 고른 폴더 대신 저장소 꼭대기로 읽어 하위 폴더를 고른 경우 권한에 막히던 것 · StrictMode 의 두 번 실행에 고르기 대화상자가 둘 뜨던 것.
- UI/UX(코드로만 — 화면 미확인): 고르기 · 체크박스는 legend 있는 fieldset 안 label, 막힌 줄은 끈 체크박스와 이유 글자, 칩은 글자(색만 아님), 긴 경로 `overflow-wrap: anywhere`, 목록만 스크롤(50dvh). 포커스는 늘 대화상자 안(읽는 중 · 가져오는 중엔 제목, 끝나면 '닫기'), Esc · 배경 클릭은 닫기(=취소), Tab 은 `Modal` 이 가둔다. 띠의 단추는 '대화로 이어 하기: <요약>' 이름, 여는 중엔 '여는 중…' 글자와 단추 끔, 오류는 `role=alert`. 새 일감 아래 줄은 단추 셋이 좁으면 줄을 넘긴다(`:has`).
- 리뷰: 아래 '리뷰' 절.

## 계획과 다르게 한 것
- preload 를 `worktrees.importPick` · `importPreview` 대신 따로 묶음 `repoImport.{pick, preview}` 로 했다 — 39 `WorktreeApi` 를 넓히면 기존 패널 시험의 가짜 구현이 모두 바뀐다. IPC 이름은 계획대로 `worktrees:importPick` · `worktrees:importPreview`.
- 변이 '보관 일감 제외' 를 중복된 앞 줄 대신 뒤의 지금 상태 검사에 걸었다(위 결과).
- reducer 의 다시 거르기는 cwd 글자 그대로 비교한다(reducer 에 홈 폴더가 없다) — `~` 를 편 비교 · realpath 비교는 바로 앞의 `importPlan`(지금 상태) · main 신원 검사가 한다.
- 계획에 없던 것: 대화상자의 '다른 저장소…' 단추(고르기를 다시) — 새 일감에서 잘못 고른 폴더를 닫지 않고 바꾸게.

## 돌려야 할 e2e (앱을 띄우지 않아 미실행)
1. 새 일감 › '저장소째 가져오기…'(고르기 대화상자는 시험용으로 바꿔 끼움) → 미리보기(기본 · 브랜치 · 잠김 · 병합됨 칩 · 막힌 줄) → 고른 것만 일감 · 묶음 '저장소 이름' · 첫 일감 선택 · 결과 목록. 같은 고름으로 다시 → 모두 '이미 일감이 있어요'.
2. 워크트리 패널 › '이 저장소째 가져오기…' → 패널을 연 일감의 줄은 '이미 일감 있음' · 끈 체크박스. 닫으면 포커스가 그 단추로.
3. 미리보기를 연 채 터미널에서 worktree 폴더를 지움 → 가져오기 결과에 '미리보기 뒤 바뀌었어요' · 그 일감 없음. 가져오는 중에 Esc → 일감 없음.
4. 가짜 claude 기록(`TASKMINAL_AGENT_SESSIONS_HOME`)이 있는 worktree 를 가져옴 → 일감 머리 띠 → '대화로 이어 하기' 가 대화 탭을 열고 그 후보가 사라짐 · '닫기' 로 띠가 사라지고 앱을 다시 열어도 없음 · 터미널로 이어 하기 명령.
5. 좁은 창(대화상자 · 새 일감 아래 줄 단추 셋) · 라이트/다크 · 큰 글자에서 줄 넘침 · 목록 스크롤.
6. 39 `tests/e2e/worktrees.spec.ts` '일감으로 열기' — 신원 검사를 `taskFolders` 로 옮겼다(같은 동작이어야 함).

## 미검증
- main 의 폴더 고르기 대화상자 · IPC 처리기 둘의 연결(단위 시험은 그 안의 `ImportRoots` · `buildImportPreview` 만).
- 실제 claude · codex 가 기록하는 cwd 가 링크 경로일 때 — realpath 로 맞추지만 실제 기록으로 대조하지 않았다(사용자 데이터 금지). 세션 기록 첫 읽기가 15초를 넘는 큰 기록 폴더에서는 첫 미리보기에 세션이 없고 '다시 읽기' 에 붙는다(53 캐시).
- 수요: 이 기능을 쓸지는 여전히 근거 없음(v6 5번 '판정 보류').

## 리뷰
(리뷰 뒤 채움)
