# 38 — 앱 실행 중 예약과 결과함

승인 범위 `docs/ideas/orca-next-five.md`. plan-check: 서버 없음 — 로컬 journal과 가짜 에이전트만 사용한다. 구현·검증·GC 완료(main 미병합).

## 동작

로컬 일감에 저장한 workflow를 연결한다. 기본 꺼짐이며 저장만으로 실행하지 않는다. 활성화하면 다음 미래 시각부터 실행한다. 분 간격(5~10080) 또는 매일 HH:mm/IANA 시간대를 지정한다. 지금 실행은 별도 명시적 조작이다. 앱 화면이 열린 동안15초 tick, OS daemon은 없다.

다음 실행·일시정지·놓침/건너뜀/완료/실패·결과 확인 필요를 표시하고 workflow 결과를 연다. 이력은 예약당100개, 예약50개. 실행 전 요청 tombstone과 claim을 원자적으로 저장한다. 요청 tombstone10000개는 자동 제거하지 않으며 한도에서 새 실행을 막는다. workflow 실행기의100회 한도는 별도로 적용된다.

## 실패·수명 계약과 verify

| 상황 | 처리·시험 |
|---|---|
| 결과를 모를 때 | claim과 request ID가 남고 unknown·이전 실행 확인 안내. 응답 유실 후 자동 재전송 없음. 시작 후 journal 쓰기 실패→재시작 시 workflow request ID로 대조 시험 |
| 다시 시도 | 지금 실행의 응답 미확인은 같은 요청 ID를 사용. 완료한 실행을 새로 요청하는 것은 새 ID. 패널 닫기/열기는 renderer 내 미확인 요청 ID 보존. 앱/renderer 재시작 뒤에는 이력을 확인하고 명시적으로 실행 |
| 이중 입력 | 동기 lock·영속 tombstone. 겹친 tick·runNow·한도와 과거 이력 잘림 뒤 중복 요청 시험 |
| 취소·뒤로·닫기 | 편집 초안 취소는 실행 없음. 예약 삭제/일시정지는 이미 실행 중인 workflow를 중단하지 않음(결과함에서 중단). 삭제 tombstone은 보존 |
| 절전·앱 종료·긴 지연 | 앱 시작/전원 resume/90초 초과 늦은 tick은 놓침 후 다음 미래 시각. 밀린 실행 몰아 실행 안 함. 주입 시계·실제 앱 시작 이력 시험 |
| DST·시계 역행 | 실제 UTC 분을 탐색해 없는 현지 시각은 그날 건너뜀. 실행한 현지 날짜 기록으로 반복 시간/역행에 같은 날짜 재실행 방지. New York 봄/가을 시험 |
| 대상 소멸·편집 | 매번 최신 일감·템플릿·진행 실행 확인, 삭제/원격/보관/겹침은 건너뜀. 이력의 일감/템플릿 ID는 실행 당시 snapshot, 예약 편집과 분리해 결과 추적 |
| 중간 단계 실패 | 앞 단계 claim 보존. workflow가 소유 프로세스를 정리하고 결과를 저장. 준비하는 중 글자 표시·15초 초기화 한도는37단계 계약 유지 |
| 앱 종료·창 닫기·새로고침·충돌 |37단계 실행 정리 유지. 예약 timer는 앱 종료 시 정리. 창 없음·로딩·충돌 때 새 tick 실행 없음. 다음 열림에 놓침/미래 예약 처리 |
| 가림·저장 오류 | 이름과 이유는 현재 가림 설정으로 view/쓰기 때 마스킹. journal 오류는 동결하며 빈 기록으로 덮지 않음 |

## 구현

`src/shared/schedules.ts`, `src/main/schedule-runner.ts`, `src/main/schedule-ipc.ts`, `src/renderer/SchedulePanel.tsx`, `src/renderer/schedule-panel.css`. 순수 엔진은 주입 시계·journal·실행기로 단위 검증하며 Electron 접착부는 임시 앱 e2e를 쓴다. 저장은 AtomicJournal을 공유한다.

## 검증·리뷰·GC

완료 후 실제 결과와 미검증을 기록한다. 초안 단위17개 통과는 전체 통과로 세지 않는다. 실제 운영 예약·계정 실행·OS 백그라운드 서비스는 검증하지 않는다. UI는 기본 꺼짐 생성→지금 실행→결과→중단, 작은 창200%·삭제 취소를 확인한다. 전역 규칙 자동 승격 없이 단계 GC 진단과 코드/시험 반영 근거를 남긴다.

가짜 실행기는 허락·진행·실패·중단·중복·한도를 시험하지만 실제 공급자 로그인/요금·실제 CLI의 설치 환경별 거절/빈 결과는 실제 대조 안 함. OS 절전은 powerMonitor 이벤트 연결과 주입 시계로 검증하며 기기의 실제 잠자기/깨우기 재현은 미검증이다.

## 독립 리뷰와 검증 근거

- 신규 모듈 없음 RED 뒤 단위17 GREEN. 독립 리뷰가 절전 복귀 이벤트보다 늦은 타이머가 먼저 돌 수 있는 HIGH를 발견했다. `ScheduleLoop`의 suspend latch를 추가하고 같은 순서의 시험을 RED→GREEN(18개)으로 확인했다. resume의 놓침 처리가 끝나기 전에 자동 실행 잠금을 풀지 않는다.
- App 결과 열기 응답은 실행 ID/일감 snapshot과 보조 패널 객체의 동일성을 확인한다. 패널을 닫고 같은 일감에서 다시 열어도 이전 응답이 새 패널을 바꾸지 않는다. workflow 결과는 정확한 run article로 스크롤·포커스한다. 실제 지연 IPC e2e로 확인했다.
- 핵심 변이5개(전송 전 claim·멱등 응답·놓친 예약·삭제 대상·DST 날짜)와 리뷰 회귀2개(suspend latch·패널 ABA) 모두 검출·원복. `/tmp/taskminal-38-mutations.log`·`/tmp/taskminal-38-review-mutations.log`, 각각20초·16초.
- 실제 임시 앱 e2e2개 통과(`/tmp/taskminal-38-e2e3.log`),37단계 종료4경로 등과 묶은8개도 통과(`/tmp/taskminal-38-e2e2.log`). 전체 결과는 다음 절에 별도 기록한다.
- UI 부분 검증: macOS/Electron 로컬 앱·라이트320 CSS px/200%, 네이티브 폼·저장·기본 일시정지·결과·삭제 확인 취소·오류 문구. 하네스 U1(상태/복구),A1(이름/키보드/확대),A2(확인창). `test-results/schedules-small-light.png` 및 재촬영한37단계 `test-results/workflows-small-light.png`를 직접 열어 확인했다. 확대 상태의 Playwright 캡처가 잘려 네이티브 capturePage를 쓰는 공통 시험 도우미로 교체했다. 캡처만으로 실제 조작/보조기술 확인을 대신하지 않는다.

## 단계 GC

읽기 전용 `/tmp/taskminal-38-gc.json`: 승격 후보 r89439e, 승격 후 재발 rd0536c, 병합 후보 없음, Electron 규칙 감사 toolable0. 후보를 자동 승격·병합하거나 전역 문구를 수정하지 않았다. 실제 회귀를 변이로 검증하고 앱/환경 사실을 소스·임시 앱으로 대조하는 방식으로 대응했다. Codex JSONL 수집기는 지원 형식이 아니므로 토큰·훅 통계는 미측정이며0으로 보고하지 않는다.

| 회고 | 반영·보류 이유 |
|---|---|
| 절전 이벤트 순서 | pure ScheduleLoop와 순서 회귀 시험으로 도구화, 해당 guard 제거 변이 검출 |
| 오래된 UI callback | 패널 객체 snapshot+실행 대상 재탐색, 실제 지연 IPC·변이 검증 |
| 이전 계획과 다른 실행 대상 | 이력마다 task/workflow ID 고정. 예약 템플릿을 바꿔도 기존 실행 추적 시험 통과 |
| 확대 캡처 도구의 잘림 | captureWindow 공통 도우미로 실제 전체 창을 기록. CDP 스크롤 대신 DOM scrollIntoView로 촬영 위치 지정 |
| 반복 패치 오류 | compact select의 두 option을 fragment로 묶지 않은 타입 오류를 수정. 원문 assert 실패 후 명령 분리, 파편 출력 대신 실패 절만 조회 |
| 모델·위임 선택 | sol medium이 순수 예약 엔진/UI 초안 및 독립 리뷰, parent가 영속성·실행 target snapshot·Electron 연결·변이/통합을 담당. 독립 worker는 초안 폴더만 편집해 실행 중인 전체 검사와 분리. parent+worker 총토큰 미측정, 절감률/최적 판정 없음 |
| 다음 개선 | 전체 UI/UX에서 고정 header·도구 줄·초안 닫기 동작을 다룬다. 실제 VoiceOver/IME/Retina/사용자 공급자 계정/기기 절전은 미검증, 참여자 테스트 없음 |

읽기/쓰기 겹침: 늦게 도착하는 옛 응답은 요청 번호·세대와 패널 snapshot으로 버린다(ABA e2e). 부수 요청은 안 보일 때 폴링을 멈추고, 앞 요청이 끝나기 전 중복 읽기를 쌓지 않으며 쓰기 뒤 한 번 다시 읽는다. 처음 한 번 읽은 설정·목록을 고정하지 않고 실제 실행 직전에 현재 일감·workflow·계정 상태를 읽는다(삭제/활성 실행 겹침 시험).

## 최종 전체 검사

`/tmp/taskminal-38-full.log` 종료0: typecheck·경계·단위1,060·e2e293 통과, 패키징 전용1 skip. e2e430초. Electron schedule IPC 접착부는 실제 임시 앱 e2e, 순수 엔진/전원 이벤트 순서는 주입 시계 단위 시험으로 검증했다. 실제 운영 계정·실제 기기 절전·보조기술 대조는 미검증이다.
