# 40 — 일감별 브라우저 탭

승인 범위 `docs/ideas/orca-next-five.md`. 기능 브랜치에서 검증 후 커밋하며 main 병합·릴리스는 포함하지 않는다.
plan-check: 서버 없음 — 임시 앱 데이터와 loopback HTTP 페이지만 사용한다. 기존 partition 정책과 사용자 브라우저 데이터는 변경하지 않는다.

## 동작·개인정보 경계

일감별 UUID 탭 6개, 새 탭·전환·닫기·키보드 방향/Home/End, 주소·제목·로딩·오류를 제공한다. 숨긴 탭의 native view는 파괴하지 않아 폼 상태를 유지한다. 네이티브 view는 전체24개, metadata는 일감200개로 제한하며 폼 상태를 버리는 자동 LRU 제거는 없다. 한도는 안내하고 사용자가 닫게 한다. 마지막 탭 닫기는 새 UUID의 빈 탭이며, 닫힌 ID에 대한 조회·표시·늦은 navigate는 탭을 되살리지 않는다.

탭 ID·선택은 기록하되 URL/제목 기억은 기본 꺼짐이다. 명시적으로 켠 일감만 query/hash를 뺀 http(s) URL과 가린 제목을 기록한다. 자격증명 URL·마스킹에 걸리는 경로·최대8번 percent decode에도 모호한 주소는 저장에서 제외한다. 민감한 URL을 변경한 주소로 복원하지 않는다. 제목은 전체 제한 입력에서 먼저 가리고300자로 줄인다. 재시작의 첫 허용 조회에서 현재 설정의 가림 정책으로 다시 검사하고 기록을 성공적으로 지운 뒤에만 복원 주소를 반환한다.

앱을 다시 열어도 페이지는 자동 로드하지 않는다. 브라우저 패널을 열면 선택 탭만, 다른 탭은 선택할 때 로드한다. 폼·POST·캡처 초안은 복원하지 않는다. 이 옵션은 앱의 **탭 복원 목록**에 관한 것이다. 쿠키·캐시 등 Chromium 저장을 없애는 개인정보 모드라고 주장하지 않는다. 기존 일감별 persist partition을 유지하며 sandbox·node 없음·앱 preload 없음·권한/다운로드/새창 차단을 유지한다.

## 캡처와 비동기 수명

main과 renderer가 task/tab ID, navigation·selection 세대, native entry·실제 URL·visibility를 캡처 전후에 비교한다. 자료 확인 뒤 페이지/선택이 바뀌면 첨부를 취소한다. 다른 탭으로 갔다 돌아온 경우도 세대가 달라 다시 캡처해야 한다. 첨부는 최신 metadata를 한 번 더 확인하고 입력 초안에만 넣으며 자동 메시지 전송은 없다.

요소 선택 listener는 숨김·탭 닫기·종료에서 제거한다. 선택20초 및 main 응답21초 제한으로 멈춘 페이지의 캡처를 해제한다. 큰 HTML은 마스킹 전 문자열을 자르지 않고 거부하며 작은 요소를 다시 고르게 한다. 입력값은 clone에서 제거한다. 화면 캡처 이미지 자체의 비밀값 인식/OCR은 제공하지 않으므로 확인 미리보기를 사용한다.

페이지가 바꾸는 제목/주소는 메모리에 반영하고250ms coalesce로 journal I/O를 제한한다. 선택·닫기·기억 옵션·종료는 즉시 flush한다. 삭제된 일감의 기록 정리는 앱 상태가 권위 있게 로드된 뒤만 수행하고 보관된 일감은 유지한다. 손상 파일은 원본을 보존하며 쓰기 실패 이후 native view를 닫고 후속 쓰기를 차단한다.

| 상황 | 처리와 확인 |
|---|---|
| 결과 모름·재시도 | 주소/조회 오류를 현재 탭에서 안내, 새 동작은 최신 세대로 실행. 캡처는 새로 확인하며 닫힌 ID 재사용 없음 |
| 이중 입력 | renderer 작업 lock·main 탭 한도/UUID 검사, 캡처와 첨부 각각 singleflight |
| 취소·뒤로·닫기 | 주소 입력은 탭별 메모리, 탭 전환으로 페이지 폼 유지. 닫기는 해당 native view만 정리. 패널 닫기는 캡처 취소·숨김 |
| 늦은 응답 | UI 수명·요청 version과 캡처 ticket으로 무시. native callback은 entry identity 검사 |
| 읽기·쓰기 겹침 | 쓰기 시작/완료 version 증가, 건너뛴 읽기는 앞 요청 완료 뒤 재조회. 비가시 상태 polling 중단 |
| 종료·복원 | 저장 옵션만 복원; 선택 페이지 lazy load. 과거 폼이나 캡처를 자동 첨부하지 않음 |

## 검증과 리뷰

`tests/unit/browser-tabs-store.test.ts`의 정책·한도·journal·현재 가림·잘림 경계20개와 `tests/e2e/browser-tabs.spec.ts` 실제 로컬 페이지/재시작/폼·키보드·캡처·손상 기록 시험을 사용한다. 기존 workspace-tools의 sandbox·모달·배율 시험도 함께 실행한다. 최종 결과는 아래에 추가한다.

UI/UX: U1 상태·복구·통제, A1 이름/키보드/확대, A2 tabs 패턴. 실제 VoiceOver·IME·Retina와 실제 공급자/사용자 계정은 미검증이며 실제 참여자 시험 없음. 전체 앱 레이아웃/초안 수명은 승인된 후속 전체 UI/UX에서 검토한다.

조회 결과를 모를 때는 현재 오류 안내를 유지하고 성공으로 표시하지 않는다. 처음 한 번 읽은 설정에 의존하지 않고 복원 조회와 저장 때 현재 가림 정책을 적용한다(현재 정책 변경 단위 시험). 부수 요청은 한 번에 하나만 읽으며 안 보일 때 중단하고, 건너뛴 요청은 앞 요청이 끝난 뒤 다시 조회한다. 쓰기 중 늦은 읽기 및 캡처 세대 변경은 version/ticket으로 검증한다.

## 리뷰 수정·단계 GC

독립 리뷰에서 보관된 일감은 metadata 보존 대상이라 native 페이지가 남을 수 있음을 발견했다. 실제 Electron에서 보관 직후 visible native child가1개 남는 RED를 확인하고, journal에 접근하지 않는 reconcileLive를 분리했다. stateSave는 읽기 전용 상태여도 native만 정리하고, 삭제 metadata 정리는 권위 있게 읽은 상태에서만 수행한다. 보관/삭제 뒤 늦은 null-hide는 인증된 창의 기존 view만 정리하므로 허용한다. 신규 lifecycle 시험과 기존 탭 시험5개가 통과했다.

핵심 metadata 변이7개는 모두 검출·원복했다(`/tmp/taskminal-40-mutations.log`,26초): 기본 opt-in 반전·6개 상한·마스킹 전 제목 자르기·선택 ABA·오래된 navigation update·복원 scrub 저장 누락·encoded secret 허용. typecheck 실패는 검출로 세지 않는다.

읽기 전용 GC 진단 `/tmp/taskminal-40-gc.json`: 승격 후보 r89439e, 승격 후 재발 rd0536c, 병합 후보 없음, Electron 규칙 감사 toolable0. 후보에는 정확한 회귀 변이/실제 Electron 대조로 대응했다. 전역 규칙 생성·승격·병합은 자동 반영하지 않았다. 이전에 확인한 Codex transcript 수집기 형식 미지원으로 토큰·훅 통계는 미측정이다.

| 회고 | 실제 조치·검증 |
|---|---|
| 민감한 문자열 자르기 | 제목은 원문 전체에서 먼저 마스킹, 큰 HTML은 자르기 대신 거부. 경계 token 단위/e2e 및 변이 |
| 현재 설정 늦게 로드 | 첫 복원 조회에서 다시 가리고 durable 저장 성공 뒤 반환. 정책 변경/쓰기 실패 시험 |
| UI 쓰기/포커스 | checkbox는 낙관 상태 후 실패 복구, 탭은 disabled 해제된 DOM commit 뒤 포커스. 실제 키보드 e2e |
| 확대 시 native 영역 | inherited flex-basis 0을 해제하고 resize 뒤 reachable 영역으로 이동. 실제 DOM 전체 가시 영역과 native bounds를 대조 |
| 시험 동기화 | HTTP 수신/저장 metadata 제목을 페이지 준비 완료로 오인한 시험을 실제 webContents URL·loading·문서로 동기화. 첫 실패 로그 보존 |
| 도구/절차 | stage 문서 plan-check의 누락 표현을 보완하고 통과. 실제 approved plan은 앞서 통과한 문서 유지. 실패를 성공으로 집계하지 않음 |
| 모델/위임 | sol medium은 renderer 키보드/확대와 후속 UIUX 초안, sol high는 개인정보/수명 독립 리뷰와 보관 native 정리. parent는 store/IPC/재시작 시험·통합·변이·전체검사. worker별 파일/빌드 슬롯을 나눔. 총토큰 미측정·절감률 주장 없음 |
| 추가 개선 | 전역 규칙 문장보다 실제 수명 guard·회귀 시험을 추가. 사용자 계정·실제 외부 사이트/VoiceOver·Retina는 별도 확인 |

## 최종 전체 결과

`/tmp/taskminal-40-full.log` 종료0: typecheck·경계·단위1,141·e2e304 통과, 패키징 전용1 skip. E2E446초. 직접 본 화면 `test-results/browser-tabs-six.png`: 선택 탭/닫기·수평 탭 목록·기억 옵션·자료 액션 위계 확인. 기존 zoom/native bounds 시험도 전체에서 통과했다. 초기 관련 검사 실패는 `/tmp/taskminal-40-e2e.log`·`e2e2.log`·`e2e3.log`에 남겼고 최종 전체 성공과 구분했다. 보관 수명 HIGH는 별도 실제 RED→GREEN을 확인했다.
