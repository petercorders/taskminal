# 37 — 재사용 가능한 에이전트 작업 흐름

승인: `docs/ideas/orca-next-five.md`. 로컬 개발·임시 userData 검증. 상태: 구현·검증·GC 완료(main 미병합).
plan-check: 서버 없음 — 로컬 journal과 가짜 공급자 프로세스로 검증하며 운영 계정으로 전송하지 않는다.

## 동작과 경계

- 로컬 일감의 작업 도구/명령 팔레트에서 템플릿을 저장하고 실행한다. 최대10단계 DAG, 실행은 한 번에 한 단계다. 최대50템플릿·100실행 이력이며 이력 한도에서는 새 실행을 거절한다.
- main이 run·step·pane UUID와 계정 바인딩을 먼저 고정한다. 준비 요청으로 전용 대화를 만들고 renderer 상태 저장→main flush 성공을 확인한 뒤 보낸다. 같은 요청 ID는 같은 실행을 반환한다.
- 전용 대화는 일반 전송·첨부·TUI·되감기를 막고 허락/질문 카드만 응답할 수 있다. main도 소유 pane 전송을 막고 설정의 자동 모드와 무관하게 ASK로 시작·유지한다.
- 앞 단계 결과는 현재 가림 설정을 적용한 최대8000자 비신뢰 참고 자료로 전달한다. 결과는 단계당20000자, 템플릿 지시는12000자 상한이다. UI 입력은10000자로 더 제한한다.
- `AtomicJournal`은 일반 파일·NOFOLLOW·10MB 제한, 고유 임시 파일 O_EXCL·0600·fsync→rename→디렉터리 fsync를 쓴다. 손상된 원본은 보존하고 쓰기를 막는다. 디스크 쓰기 실패 후 후속 전송을 차단한다.
- 중단은 실행 소유 대화만 닫는다. 준비 중 늦은 응답도 전송하지 않는다. 실패/불명 재시도는 새 pane과 기존 계정 바인딩, 새 attempt로 시작하고 완료 단계를 다시 보내지 않는다. 원래 계정이 없어지면 거절한다.
- main 준비/전송 수락은15초 제한. 독립 리뷰에서 Codex initialize/첫 turn 수락 응답이 무한 대기할 수 있음을 발견해 초기화 합계 및 RPC 응답15초 제한을 추가했다. 수락 불명은 unknown으로 기록하고 이전 대화 확인을 안내한다. 이미 수락한 정상 실행/허락 대기는 시간 제한하지 않는다.

## 실패·수명

| 상황 | 처리 |
|---|---|
| 결과 불명 | unknown 상태·이전 대화 확인, 자동 재전송 없음. 재시도 확인에서 중복 실행 가능성을 설명 |
| 중복 요청 | 영속 request ID와 일감별 진행 실행 검증. 다른 일감/템플릿에 같은 ID 사용 거절 |
| 취소·패널 닫기 | 편집만 닫고 이미 시작한 실행은 이력에 남음. 실행 중지로 소유 프로세스만 종료 |
| 삭제·보관·pane 닫기 | 최신 main 상태와 대조해 중단, 다음 단계 전송 거절 |
| 앱 종료·창 닫기·새로고침·renderer 충돌 | 소유 프로세스 정리·중단 저장. 비정상 앱 종료 뒤 열린 journal은 unknown, 자동 재생 없음. 기존 사용자 셸 정책 보존 |
| 쓰기 실패 | 준비 완료를 주장하지 않으며 journal 오류 시 실행기 동결. state 저장 실패도 전송 거절 |

## 구현

`src/shared/workflows.ts`, `src/main/atomic-journal.ts`, `src/main/workflow-runner.ts`, `src/main/workflow-ipc.ts`, `src/renderer/WorkflowPanel.tsx`, `src/renderer/workflow-panel.css`.
IPC는 workflowsView/Save/Remove/Start/Stop/Retry. `src/main/index.ts`·preload·renderer CLI bridge·store·ChatManager 연결.
Electron IPC 접착부는 실제 임시 앱 e2e로 검증하며 순수 실행기와 실제 journal 파일은 단위 시험한다.

## 검증 기록

- RED: 신규 실행기 모듈 없음, Codex 응답 제한 회귀6건. GREEN: 실행 순서·계정 pin·중복·허락·실패/재시도·중단·재시작·손상 journal·쓰기 실패·가림·불명 수락.
- 실제 앱 e2e6개: 가짜 Claude→허락→Codex 완료, 중복 요청·일반 전송 거절, 종료 뒤 재전송 없음, 작은 창200% 폼 저장·삭제 취소, reload/crash/window close의 실행 중단과 기존 셸 유지.
- 시험 선택자 두 건 수정: 허락 탭 닫기를 허락 카드로 오인한 넓은 정규식, ConfirmDialog 역할(dialog 대신 alertdialog). 런타임 결함으로 세지 않는다. crash Page는 Playwright 재사용 불가여서 기존 terminal 시험처럼 main의 executeJavaScript로 재확인한다.
- 변이 최초6개에서3검출·3미검출. 중단 시험의 validPane 우회와 ASK 인자 검증을 보강해2개 검출. 가림은 중복 방어여서 이벤트 한 줄 제거가 잡히지 않았고, 과거 이름의 현재 설정 가림 회귀를 별도 변이로 확인했다(첫 조기return 변이는 컴파일 실패로 판정 불가, 값 치환으로 재실행·검출). 최종 서로 다른 핵심 회귀6개 검출, 모두 원복. 로그 `/tmp/taskminal-37-{mutations,review-mutations,mask-mutation}.log`.
- 최종 전체 `/tmp/taskminal-37-final2-full.log` 종료0: typecheck·경계·단위1,042·e2e291 통과(패키징 전용1 skip), e2e434초. 앞선 `/tmp/taskminal-37-full.log`·`/tmp/taskminal-37-final-full.log`는 정확 비교4건 실패로 종료1이며 통과로 세지 않는다.

## UI/UX

부분 검증. macOS/Electron 로컬 앱1200×768 다크,640×400/200%(320 CSS px) 라이트, 키보드·네이티브 폼·오류 안내·삭제 취소 확인. `test-results/workflows-waiting.png`, `test-results/workflows-small-light.png` 직접 열어 확인했다. 작은 화면의 중복 여백·중첩 스크롤을 줄였다. 큰 화면의 중복 제목과 전체 도구 표시 밀도는 승인된 후속 전체 UI/UX에서 다룬다.
기준: 하네스 U1(상태/복구/사용자 통제), A1(이름·키보드·확대/리플로), A2(확인창). 실제 VoiceOver·한글 IME·Retina·실제 공급자 계정/과금·설치 앱 대조는 미검증, 실제 참여자 사용자 테스트 없음. 자동 시험만으로 접근성 인증/95점 승계 주장하지 않는다.

## 단계 GC

최종 검사 후 읽기 전용 진단·수정 근거를 기록한다. 전역 규칙 자동 생성/승격은 하지 않는다.

계획 보충: 결과를 모를 때 unknown·이전 대화 확인 안내를 보이고 재시도 확인을 거친다(불명 수락 단위 시험). 중간 단계 실패 시 앞 단계 프로세스를 닫고 새 attempt의 준비부터 다시 시작한다(Codex 초기화6건·새 pane 재시도 시험). 준비하는 중 상태 글자를 표시하고15초가 지나면 실패/불명으로 닫는다(응답 제한 시험).

GC 근거: `/tmp/taskminal-37-gc.json`. 승격 후보 r89439e는 이번에도 정확한 회귀 변이로 검토했다. 미검출을 숨기지 않고 시험/변이를 수정했다. 승격 후 재발 rd0536c는 환경 사실을 소스/실제 임시 앱으로 대조하는 방식으로 대응했으며 전역 규칙·메타데이터를 자동 변경하지 않았다. 병합 후보 없음, Electron 규칙 감사 toolable0. Codex JSONL은 retro-collect 지원 형식이 아니므로 토큰/훅 누락0으로 보고하지 않고 미측정으로 남긴다.

| 회고 | 조치·근거 |
|---|---|
| 독립 리뷰의 초기화 무한 대기 | Codex RPC/전체 준비15초 제한과6개 RED→GREEN 시험으로 반영. 사용자 질문 대기는 유지 |
| 변이 시험의 가짜 안전망 | 준비 중 중단의 validPane 전제·ASK 실제 argv를 고쳐 확인. 가림은 정확한 과거 데이터 회귀로 재실행 |
| 잘못된 시험 선택자·crash Page 재사용 | 역할·범위·기존 main 측 관찰 방법으로 수정. 전역 판단 규칙 추가보다 실제 e2e에 반영 |
| 전체 검사 재실행 | uncertain 필드 추가 뒤 기존 정확 비교4건을 함께 바꾸지 않아 초기 단위 검사 실패. 실제 예상 이벤트에 필드를 추가해 수정. 문자열 패치 assert 실패 뒤 불필요한 전체 실행1회 추가, 이후 명령을 분리 |
| 모델·멀티에이전트 | parent 통합·지속성 검토, sol medium renderer/예약 순수 로직, sol high 독립 보안 검토·Codex deadline. 역할이 겹치지 않게 파일/임시 폴더로 구분. parent+worker 총토큰은 미측정, 절감률 주장 없음 |
| 개선 후보 | 전체 UI/UX에서 중복 제목·편집 중 닫기·보조 패널 고정 header 검토. 큰 출력 대신 실패 절만 읽기. 전역 학습 승격은 사용자 선택 전 보류 |
