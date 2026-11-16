# 47 — GitHub·Linear 이슈 연결

승인: `docs/ideas/orca-next-five-v2.md`의 47단계. 실제 계정의 이슈·PR은 변경하지 않는다. 연결 버튼과 외부 상태 변경 버튼은 별개이며, 본문은 비신뢰 참고 자료로 취급한다.

## 설계와 순서 → verify

| 순서 | 동작·경계 | verify |
|---|---|---|
| 1 | GitHub `gh api` 또는 Linear GraphQL로 목록·커서를 읽는다. GitHub 저장소 경로·응답 URL과 요청 번호, Linear 팀·응답 ID를 확인한다. 인증은 기존 gh 또는 main 메모리·환경 변수에만 둔다. | 가짜 gh/주입 Linear로 페이지 추가·PR 제외·잘못된 URL/팀·닫힌 이슈·권한/네트워크 오류 |
| 2 | 사용자가 이슈·폴더·선택적 worktree/기준을 고르고 확인한다. 옵션별 요청 UUID와 확인 당시 내용을 캡처한다. `Issues.prepare`는 명시 필드로 요청을 비교하며 JSON 속성 순서에 의존하지 않는다. | 확인 취소는 생성 0개, 같은 요청 동시 호출·다른 내용 재사용 거절 |
| 3 | main이 authoritative 이슈를 다시 읽고 pending receipt/task ID를 먼저 저장한다. 실제 Git checkout은 기존 worktree 서비스의 요청 영수증을 사용한다. | 임시 Git에서 실제 checkout 1개·원래 cwd/브랜치/파일 유지 |
| 4 | 내부 `issue.prepare` 요청으로 지정 task ID의 빈 Claude 대화와 비신뢰 이슈 메모를 만든다. renderer 상태 전송 뒤 main이 writer를 flush하고 디스크에 있는 task cwd를 확인한다. 시작 명령·자동 prompt 전송은 없다. | checkout 성공 뒤 pane 준비 실패·일감 저장 후 응답 유실·완료 저널 실패에서 기존 자원으로 재시도 |
| 5 | 링크를 journal에 저장한 뒤 메모리 상태를 교체한다. 준비/PR/닫기 쓰기는 한 큐로 직렬화한다. 연결 열기와 대화 입력칸에 넣기는 각각 사용자 클릭으로 수행한다. | journal 실패 뒤 메모리의 완료 오인 방지, 새 프로세스의 연결·PR·closed 상태 복원 |
| 6 | PR 주소는 HTTPS GitHub·같은 저장소 경계를 검증한다. 외부 닫기는 이슈 URL을 보여 주고 별도 확인 뒤에만 PATCH/Linear 완료 상태 변경을 요청한다. | 다른 도메인·다른 저장소·userinfo 거절, 취소 시 PATCH 0회, 확인 뒤 가짜 서비스 closed |

## 코드와 계약

- `src/main/issues.ts`: 제공자 조회, bounded Linear 응답, 생성 receipt, 실제 checkout, durable 링크, PR URL 및 외부 닫기.
- `src/main/issues-ipc.ts`: trusted frame 확인, 좁은 API 등록, UI 요청과 main 디스크 상태 확인. `src/main/index.ts`에서 설치한다.
- `src/shared/issues.ts`: `IssueApi`, `IssuePrepare`, `IssueRecord`, `IssuePage`, `IssueLink`.
- `src/shared/ipc.ts`: `issues:list`, `issues:configure`, `issues:links`, `issues:prepare`, `issues:link-pr`, `issues:close`. preload는 이 동작만 제공한다.
- `src/shared/cli.ts`·`src/renderer/cli-bridge.ts`: 소켓 공개 명령과 구분된 내부 `issue.prepare` 요청. 실제 `task/create` 뒤 기존 포커스를 복원하며 숨은 pane을 띄우지 않는다.
- `src/renderer/IssuesPanel.tsx`: task/root별 메모리 초안·요청 번호, 읽기 합치기, 확인 snapshot, 이슈 맥락 첨부. 토큰은 component password 상태에만 잠시 머물며 적용 클릭 때 비운다.
- `src/renderer/App.tsx`, `src/renderer/Sidebar.tsx`, `src/shared/keymap.ts`: 이슈 연결 도구·명령 진입, task ID 재탐색 후 열기·대화 초안 채우기.

## 실패·재시도·취소와 수명

- 준비 중 결과를 모르면 최근 요청 번호를 표시한다. 같은 설정으로 다시 준비하면 같은 UUID로 조회·재시도하며 task ID와 이미 만든 checkout을 재사용한다. 성공을 추정해 새 자원을 만들거나 외부 변경을 자동 재전송하지 않는다.
- checkout 뒤 일감 생성/저장 실패는 pending receipt와 실제 경로를 보존한다. 다음 시도는 같은 checkout에서 이어 간다. 완료 journal 실패는 memory 완료 표시를 앞세우지 않으며 기존 저장된 일감으로 재저장한다.
- 확인창의 저장 내용은 연 순간에 캡처한다. 그 사이 일감이 사라지거나 보관/원격으로 바뀌면 main과 App에서 현재 ID를 다시 확인해 거절한다. 이미 완료된 연결의 일감 삭제는 새 task를 조용히 재생성하지 않는다.
- 뒤로·패널 닫기·다른 일감 이동은 조회/폴더/PR 초안을 메모리에 보존한다. 마지막 consumer가 닫히거나 document가 숨겨지면 예약 조회를 지운다. 느린 이전 응답이 숨겨진 화면의 추가 조회를 시작하지 못하며 다시 보이면 읽기를 재개한다.
- 쓰기 시작 때 read 버전을 올려 이전 links 응답을 버린다. links 읽기는 한 번에 하나이며 건너뛴 알림/재열기는 consumer가 보일 때 앞 요청 뒤 한 번만 이어 읽는다. 원문 토큰·계정 credential은 renderer 초안 store, localStorage, state journal에 저장하지 않는다.
- 앱 종료·창 닫기·renderer reload·충돌은 메모리 UI 초안을 끝낸다. 영속 receipt/링크/checkout은 남으며 복귀 후 같은 요청·task ID로 이어 간다. 외부 이슈/checkout은 닫기 때문에 자동 취소·삭제하지 않는다.
- GitHub 호출 20초, Linear 호출/본문 읽기 15초 제한과 4 MB 응답 제한을 적용한다. UI에는 읽기/처리 상태와 다시 조회·연결 목록 다시 읽기·동일 요청 재시도 동작이 있다.

## 검증 결과 (2026-11-14)

- `npx vitest run tests/unit/issues.test.ts tests/unit/cli-bridge.test.ts`: 21개 통과. 이 중 Issues 새 단위 8개, 지정 ID 생성·기본 템플릿 명령 미실행 새 회귀 1개를 포함한다.
- `npm run build`: 통과. `npx playwright test tests/e2e/issues.spec.ts --reporter=line`: 5개 통과. 최초 7.2초, 최종 캡처 보강 후 23.0초. 실제 서비스는 임시 fake-gh executable로만 호출했고 Linear 인증 UI는 IPC fixture로 확인했다.
- native e2e는 실제 Git checkout·중복 준비·취소·맥락을 입력칸에만 추가·PR 검증·명시적 외부 닫기·앱 재실행 복원을 확인했다. 느린 실제 `issues:links` IPC를 gate하여 close/reopen/close 및 document.hidden 뒤 추가 조회 0회를 확인했다.
- 핵심 변이 2개: 요청 내용 변경 재사용 거절 우회, 같은 저장소 PR 경계 제거. batch 기준 실행·대상 타입 검사 후 모두 시험 실패로 검출했고 원복했다. 판정 불가 0개. 목록 `/tmp/taskminal-47-mutations.tsv`, 좁힌 backend 타입 설정 `/tmp/taskminal-47-typecheck.json`.
- 전체 `npm run typecheck`와 경계 검사 통과. 통합 전체 검사는 부모의 46/48 작업과 분리한 최종 tree에서 확정한다. 이번 관련 검사와 전체 검사 완료를 혼동하지 않는다.
- `/tmp/taskminal-47-issues-wide.png`, `/tmp/taskminal-47-issues-small.png`를 직접 열어 다크 준비 폼과 라이트 640×520/200%에서 PR 입력의 폭·스크롤 접근을 확인했다. 실제 VoiceOver·IME·외부 서비스 로그인·Windows/Linux GUI는 미확인이다.

## GC — 읽기 전용

`harness-gc`의 읽기 전용 진단을 실행했다. 결과 `/tmp/taskminal-47-gc.json`: eden 72, survivor 28, cold 12, promoted 6. 승격 후보 `r89439e` 1개, 병합 후보 0개, 규칙 파일 감사 17개. 기존 `rd0536c`의 승격 후 재발 11회도 출력됐으며 이번 단계가 그 기록을 추가한 것은 아니다. apply/promote/reinforce 등 전역 상태는 변경하지 않았다.

| 영역 | 근거와 처리 |
|---|---|
| 판단·비동기 | 리뷰가 찾은 숨겨진 후속 조회를 consumer/visibility 경계와 gate e2e 2개로 도구화했다. 추가 규칙 문장 대신 실제 회귀 시험을 유지한다. |
| 도구·보고 정정 | 파일 생성 앞의 잘못된 rg 정규식과 && 연결이 신규 IPC 파일 생성을 건너뛰었다. 타입 검사와 부모의 파일 존재 확인이 잡았고 실제 파일 생성 후 다시 검사했다. 공유 통합을 완료했다는 중간 보고도 부모에게 정정했다. 기존 typecheck가 이 누락을 막으므로 새 전역 훅은 만들지 않는다. |
| 모델·위임 | 기본 모델을 유지한 worker가 UI에서 47단계 통합까지 이어 맡았고 부모가 서버/경계 코드를 별도 검토했다. 공유 App/preload는 46 snapshot 뒤 순차 편집, build/out은 서로 메시지로 조정했다. 품질 목적 분담은 관측상 적합하나 더 싼 모델과 동등 품질은 비교하지 않았다. |
| 토큰·비용 | 부모·worker의 원시 usage를 전달받지 못해 총량과 금액은 미측정이다. 출력이 큰 skill/GC JSON 읽기는 필요한 절·집계로 줄일 후보이며, 절감률이나 최소 비용은 주장하지 않는다. |

별도 skill/모델/전역 규칙 변경은 보류했다. 다음 반복에서는 신규 파일 실재 여부와 targeted typecheck를 통합 보고 전에 확인하고, 느린 읽기 후 마지막 consumer 소멸을 UI 수명 시험에 포함한다.

## 전체 검사 뒤 정정

고정 tree `72a360c0dece93cdbd1ddd062cd9cb76681a7900`의 타입·경계·단위1,201 통과, 전체 e2e는337통과·2skip·2실패였다(`/tmp/taskminal-47-full.log`, script 종료1). 실패는 신규 issues API를 누락한 보안 기대 목록과 기존 셸 지킴이의 늦은 파일 쓰기와 겹친 임시 폴더 정리였다. API 검사를 삭제하지 않고 issues의 정확한 여섯 메서드를 명시했으며, 임시 폴더 정리는 다른 fixture와 같은 제한된 rm 재시도를 사용한다. 수정 후 창·sandbox/API·지킴이 e2e6개 전부 통과(`/tmp/taskminal-47-final-fix.log`). 처음 실패한 전체 검사나 자동 재실행을 전체 종료0으로 보고하지 않는다. 이 시험 두 파일만 변경하여 관련 검사를 다시 했으며 앱 구현은 바뀌지 않았다. 최종 전체 통합 확인은48단계에서 수행한다.

GC 추가: 새 preload 기능을 노출한 뒤 exact allowlist 시험 갱신을 놓쳤다. 기존 보안 시험이 이를 찾아 수정했으므로 새 규칙 문장·전역 훅을 만들지 않고 기존 시험의 좁은 목록을 유지한다. 실제 정리 경합도 bounded fixture 재시도로 도구화했으며 실 사용자 폴더 정리에는 적용하지 않는다.

최종48 통합 전체 검사에서 단위1,206·e2e341·타입/경계가 script 종료0으로 통과했다(`/tmp/taskminal-48-full.log`). 위 두 시험 정정도 포함했으며 처음47 전체의 실패 기록은 보존한다.
