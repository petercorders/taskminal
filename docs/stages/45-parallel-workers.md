# 45 — 병렬 에이전트와 격리 worktree

사용자 승인·공통 계약: `docs/ideas/orca-next-five-v2.md`.

- 기존 템플릿은 maxParallel=1로 동작한다. 1~4개 슬롯·선행 완료 조건을 지원하고 병렬은 isolate=true가 필수다. 준비/진행/질문 대기 모두 슬롯을 점유한다. 슬롯을 먼저 예약하고 pane 준비는 직렬, 에이전트 실행은 병렬이다.
- worker마다 실제 별도 git worktree/cwd/branch를 만든다. 생성 receipt와 run/step 상태를 저장하고 실패/중단에도 폴더를 자동 삭제하지 않는다. 재시도는 기존 수정본을 재사용하며 원래 일감 cwd는 바꾸지 않는다. 종합 단계에 선행 결과와 경로/브랜치를 전달하며 변경을 자동 병합하지 않는다.
- 실패 시 실행 중인 형제를 중단하고 완료 단계는 그대로 둔다. 재시도는 실패/중단/불명 단계만 새 pane/attempt·동일 계정 바인딩으로 시작한다. 이전 준비 attempt의 늦은 응답은 세대 확인으로 새 pane을 만들거나 지시를 보내지 못한다.
- 긴 단계 ID는 고정 길이 hash로 Git branch/request ID를 생성한다. 인터페이스에서 허용한 입력이 실패 상태 journal까지 망가뜨리지 않게 한도를 맞췄다.
- Red: 새 병렬 두 시험이 기존 순차 구현에서 실제 1개만 실행돼 실패(`/tmp/taskminal-45-red.log`). Green: runner/실제 Git 단위16개, 관련 e2e8개 통과(`/tmp/taskminal-45-final-e2e.log`). fake Claude의 부분문자열 분기가 taskminal 경로의 ask를 사용자 질문으로 해석하던 시험 오탐은 이 신규 시험에서만 첫 지시 줄을 분기하도록 고쳤다. 실제 에이전트 계정/과금은 사용하지 않았다.
- 독립 리뷰의 stop/retry attempt 경합·긴 ID 문제를 실제 코드/단위로 고쳤다. 종료/reload/crash 기존 정책과 사용자 셸 유지 회귀를 함께 확인했다. 화면 증거 /tmp/taskminal-45-workflow-wide.png·small.png는 최종 확인한다.

## GC

기존 r89439e 후보는 정확한 회귀 변이로 도구화, 전역 규칙은 자동 변경하지 않는다. UI worker는 설정·표시·실제 Git UI시험, 읽기 전용 worker는 수명/경계 리뷰를 맡았으며 부모가 scheduler/격리/backend통합을 구현했다. 총토큰/금액은 미측정이다. 변이·전체 검사 결과는 완료 후 아래에 기록한다.

## 최종 결과

고정 tree `71479b5675a8462e8ce9236f5b8fa30a15a1fb70`의 별도 복사본에서 전체 종료0(`/tmp/taskminal-45-full.log`): 타입·경계·단위1,191·e2e330 통과, 패키지 전용2 skip. 병렬/의존성/실제cwd 변이3개 모두 검출(`/tmp/taskminal-45-mutations.log`), GC진단 `/tmp/taskminal-45-gc.json`. wide/light200 캡처를 직접 열어 경로·슬롯·설정 접근을 확인했다. 실제 계정/OS 전경·보조기술은 별도 확인이다. 체크아웃은 독립적이며 자동 병합하지 않는다.
