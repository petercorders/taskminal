# 33단계 — GitHub 원격 · PR 흐름

상태: 기능 모듈 구현 · 단위/실제 로컬 Git 통합 · 통합 타입 검사 확인. 화면 연결·Electron e2e·전체 검증은 부모 통합에서 수행.
기준: 승인 계획 `~/.claude/plans/taskminal-orca-five-areas-2026-11-13.md`, main c6ed6dd.

## 동작

변경 검토에 원격·upstream·로컬 ahead/behind·PR 상태를 함께 표시한다.
원격이 여러 개면 자동 선택하지 않고 사용자가 고른다. base는 remote HEAD 또는 GitHub 기본 브랜치에서 읽고 사용자가 바꿀 수 있다.
ahead/behind는 마지막 로컬 원격 추적 ref 기준이며 네트워크 fetch가 끝났다고 표시하지 않는다.

- `GitWorkflowService.view`: 실제 저장소 root · branch · SHA, 원격, GitHub 연결, 현재 head/base의 열린 PR.
- `push`: 선택한 SHA를 선택한 원격의 해당 브랜치에 일반 push. 강제 push 없음. 전후 ls-remote로 결과 확인.
- `create`: 제목·본문을 보존하고, 먼저 기존 PR·push된 SHA를 확인한다. 본문은 gh의 표준입력 body-file로 전달한다.
- `merge`: PR 번호·repo·base/head·SHA를 확인 화면에 표시. 실행 직전 다시 읽고 draft·리뷰·체크·충돌을 검사한다. gh의 match-head-commit으로 서버 쪽 SHA 경합도 막는다. squash 병합이며 보호 규칙 우회·auto merge 없음.

## 경계와 비동기

프로세스는 main에서 execFile과 인자 배열로 실행한다. renderer 임의 명령·셸 문자열은 받지 않는다.
root는 realpath로 다시 확인하며 모든 쓰기는 같은 root 잠금으로 중복 입력을 막는다.
사용자가 본 SHA와 실행 직전 SHA가 다르면 변경 안내를 반환한다. 같은 SHA의 재push는 원격 조회로 성공을 확인한다.
PR 생성 전 '시작됨/불명 결과' 식별을 0600 임시 파일 → rename으로 기록한다. 응답 유실·앱 재시작 후 기존 PR을 먼저 읽고, 아직 확인할 수 없으면 자동 재생성하지 않는다.
기록 파일 경로는 main 생성 시 두 번째 인자로 넘겨야 한다. 기존 PR 조회로 조정하거나 확실한 실패일 때만 해당 식별을 제거한다.
화면을 닫으면 외부 작업이 취소됐다고 표시하지 않는다. 새로 들어왔을 때 다시 읽는다.
창/renderer 수명에 따른 작업 기록과 구독은 앱 공통 통합 문서도 함께 확인한다.

- gh 없음 / gh 인증 실패 / GitHub 아닌 원격 / PR 조회 실패를 구별한다.
- remote URL의 HTTP 자격증명과 query/fragment는 화면에 보내지 않는다. subprocess stderr 원문도 보내지 않는다.
- renderer는 읽기 번호로 늦은 응답을 버리고 동기 ref로 중복 클릭을 막는다. base 입력은 적용 버튼으로 확정하므로 글자를 칠 때마다 다시 읽어 포커스를 빼앗지 않는다.
- PR 확인이 열린 뒤 대상이 달라지면 확인을 닫고 실행 직전 snapshot 검사도 적용한다.

## 검증

단위/통합 10개: 초기 모듈 미존재 빨강 → 구현 후 통과.
`npx vitest run tests/unit/git-workflow.test.ts`

- 원격 없음·여러 원격·detached HEAD.
- 임시 bare 원격에 실제 push, 같은 SHA 재시도, 실제 로컬 HEAD 변경 차단.
- 가짜 gh의 PR 응답 유실 뒤 재조회, 조회 지연 중 재POST 방지, 서비스 재시작 후에도 방지.
- 실패 체크 또는 PR SHA 변경이면 gh merge를 호출하지 않음.
- 같은 프레임 두 번 쓰기 중 하나만 실행.
- gh 없음과 인증 거절 상태 구분.

변이 4개 모두 잡음: 로컬 SHA 재검사 제거, PR SHA 재검사 제거, 실패 체크 검사 제거, 불명 PR 재전송 방지 제거.
목록 `/tmp/taskminal-gitflow-mutations.tsv`. TS 단위 변이는 Vitest 변환으로 검증하고 전체 typecheck는 통합 검사에서 별도로 수행했다. 병합 확인창은 취소 버튼 초기 포커스·닫은 뒤 복귀와 확인 중 HEAD 변경을 e2e로 검사한다.

가짜 gh가 흉내 내지 않는 실제 GitHub 인증·보호 규칙·리뷰 정책·eventual consistency·네트워크 쓰기는 실서버 대조 안 함. 실제 계정/원격에 PR·push·merge 테스트 자원을 만들지 않았다.
GitHub 외 원격의 push는 지원하지만 PR 기능은 github.com의 gh 지원 범위다. Enterprise GitHub와 fork에서 원본 저장소로 보내는 교차 저장소 PR은 현재 미지원. headRefName과 isCrossRepository를 확인해 다른 fork의 같은 이름 브랜치를 현재 PR로 잘못 잡지 않는다.
공식 계약: https://cli.github.com/manual/gh_pr_create · https://cli.github.com/manual/gh_pr_merge
