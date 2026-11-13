# 36단계 — 대화 기록 통합 검색

승인 계획: `docs/ideas/orca-next-five.md`. 상태: 구현·리뷰·검증·GC 완료, main 미병합.

## 구현·수명

- `src/main/conversation-search.ts`가 현재 상태에 연결된 chat pane만 읽는다. 경로를 입력받지 않고 pane ID·O_NOFOLLOW·일반 파일·2MB 한도, 64 pane/200결과 상한을 적용한다. 손상/읽기 실패는 빈 결과와 구분한다.
- 검색은 현재 사용자 지정 가림/허용 설정으로 가린 사용자·assistant 본문만 대상이다. 도구 출력·고아 pane·기본 보관 일감을 제외한다. 일감·에이전트·보관 포함 필터 제공.
- 선택 시 user 이벤트 지문을 다시 확인하고 정확한 탭/pane·user 턴으로 이동한다. 보관 일감은 별도 복원 확인 후 다시 결과 선택. 자동 메시지 전송 없음.
- 검색 UI는 150ms debounce·세대 번호로 옛 응답을 버리고 닫기/필터 변경 시 이전 결과를 무효화한다. main은 조회 전용이므로 앱 종료·창 닫기·reload·충돌 뒤 남는 프로세스가 없다.
- Modal의 초기 검색 포커스·Escape/Tab·복귀, native 필터·결과 버튼을 사용한다. 실제 VoiceOver·IME·Retina·참여자 검증은 미수행.

## 검증·리뷰

- 구현 전 모듈 미존재 RED → unit 2개 GREEN. 실제 임시 JSONL에서 가림·역할·연결·보관/agent·검증 지문·symlink·입력 제한 확인.
- e2e 2개: 실제 검색/필터→정확한 대화 이동, 기록 변경 후 잘못된 이동 차단, 최소 창 200%/라이트/가로 넘침·닫기. 기존 window 보안 5개도 통과.
- 최초 e2e의 getByLabel exact가 select의 label 텍스트를 찾지 못해 timeout. 접근성 트리에 확인된 combobox 이름으로 선택자를 고치고 원래 행동 조건을 유지했다. 재검증 `/tmp/taskminal-36-layout-check.log` 2통과.
- 변이 3개(검색 전 가림 제거·고아 pane 제외 제거·지문 반전) 모두 검출/원복, `/tmp/taskminal-36-mutations.log`, 2초. 같은 과거 회귀가 아닌 것을 잡고 같은 회귀라고 세지 않는다.
- UI/UX 부분 검증: macOS/Electron·다크/라이트·최소 창 200%, 실제 local 과업과 캡처 `test-results/conversation-search*.png` 열람. 기존95점 자동 승계 없음.

## GC — 단계 종료

- 규칙 GC 실행 `/tmp/taskminal-36-gc.json`: 승격 후보 r89439e(정확한 변이), 병합 후보 없음, Electron 규칙 감사의 도구화 후보 없음. 승격 후 재발 rd0536c는 환경 사실을 코드·CLI로 확인하는 데 적용했다. 전역 엔트리 변경/승격 없음.
- retro-collect는 실제 Codex JSONL을 지원하지 않아 집계 실패(0이 아닌 미확인). 오류를 감추지 않고 명령/검증 로그로 이 문서에 수동 회고했다. Codex 어댑터 추가는 하네스 도구 개선 후보지만 이번 제품 구현 범위 밖으로 보류한다.
- 모델: 부모 유지, UI 구현 gpt-6.1-sol medium 범위 worker 1개(2파일), 다음 단계의 고위험 API 조사 gpt-6.1-sol high 읽기 전용 worker 1개. 시간·독립 검토 목적이다. 전체 문맥 복사 없이 task packet 전달, input/output/cache/reasoning 총사용량 미측정.
- 도구화한 문제: stale 대상 지문·symlink 경계·실패 UI를 실제 시험으로 남겼다. generic 판단 규칙을 새 문장으로 중복 추가하지 않았다.

## 최종 검증과 리뷰 보강

- 전체 검사 `/tmp/taskminal-36-final-full.log`: 타입·경계·단위 1,021개·e2e 285개 통과, 패키지 1개 제외, 종료 0. 첫 전체 실행의 불안정 3개와 이후 보강 기록은 삭제하지 않는다.
- 독립 읽기 전용 리뷰가 지적한 HIGH 3개를 수정했다. 저장 index 대신 canonical SHA 메시지를 실제 메모리 이벤트에서 찾아 이동, 이동을 소비해 반복 포커스 금지, 닫기 AbortSignal로 늦은 부모 이동 차단. 같은 timestamp/text/images가 둘이면 모호하므로 이동하지 않고 재검색 안내한다. 재리뷰에서 추가 HIGH 없음.
- 추가 e2e: hot pane의 디스크 trim 뒤 정확한 턴·포커스 유지, 지연 검증 중 닫기, 모달에서 전역 팔레트 단축키 차단. 마지막 새 e2e 4개 통과.
- 기존 안전 시험이 드러낸 startup migration 경합은 읽기 반환 경계에서도 redact하여 고쳤다. 첫 정리 전에 raw 파일을 load하는 정확한 단위 회귀를 RED→GREEN으로 확인했다. 초기 fixture 누락 폴더를 고친 후에 원문 노출 assertion 실패를 확인했으며 준비 실패를 회귀 검출로 세지 않았다.
- 보관함 시험은 실제 combobox 포커스를 기다린 뒤 타이핑, 복원 시험은 확인창 소멸 후 실제 닫기 버튼 포커스에서 Escape, 활동 시험은 임시 폴더 삭제 재시도 5회로 준비/정리 경합을 보강했다. 행동 assertion은 유지한다.
- 추가 변이 5개(원문 복원·직렬 검색 최신 요청 무시·닫기 취소·trim된 disk0을 UI0으로 재사용·모달 guard)를 모두 검출하고 원복했다. 총 8개. `/tmp/taskminal-36-review-mutations.log` 23초. 전체 검사는 원복 뒤 재빌드한 소스다.
- GC 재실행 `/tmp/taskminal-36-final-gc.json`: 기존 승격/재발 후보와 추가 규칙 감사 변화 없음. 숫자 index를 영구 identity로 쓰지 않는 판단은 메시지 지문/모호성 guard와 실제 trim 회귀 시험으로 도구화했다. Codex 수집기 미지원은 이 문서의 수동 회고로 대체하고 자동 집계를 0으로 기록하지 않는다.
