# 전체 UI/UX — 36~40 후속

상태: 구현·검증·GC 완료, 기능 브랜치 `stage-36-40-orca-followup`(main 미병합). 최종 전체 종료0: 단위1,141·e2e316·패키징1 skip, UI/UX 변이13개 검출·원복.

사용자 추가 승인: “전부 끝나면 하네스 ui/ux도 진행해주고 그것도 gc 진행해줘”. 승인 계획 `docs/ideas/orca-next-five.md`의 추가 UI/UX 범위를 따른다.
plan-check: 서버 없음 — 임시 사용자 데이터·임시 Git·loopback 페이지·가짜 에이전트만 사용한다.

## 계획과 verify

1. 주요 화면을 기존 회귀와 직접 보는 화면으로 확인한다: 사이드바·터미널·대화/분할·전체 보기·검색·설정·보관/되돌리기·파일/브라우저/GitHub·작업 흐름/예약/worktree. 최소640×400(200%의320 CSS px 포함), 대표900×600/1200×800, 넓은1440×900, 라이트/다크. verify: 실제 Electron 과업·DOM경계·native화면 캡처.
2. 작업 흐름과 예약의 미저장 초안을 패널 닫기/일감 전환 동안 메모리에 보존한다. 앱 종료·새로고침에서 사라짐을 안내한다. 명시적 취소·저장 성공은 제거, 다른 편집으로 이동은 버리기 확인. 지연 선택 대상은 최신 목록에서 id로 확인하고 사라지면 기존 초안 유지. verify: workflow/schedule draft 전환·버리기 취소/확정·실제 journal 미기록.
3. 쓰기 동안 읽은 옛 목록이 새 상태를 덮지 않게 version을 비교하고, 앞 요청이 끝난 뒤 건너뛴 요청을 다시 한 번 처리한다. 부수 요청은 한 번에 하나, 안 보일 때 중단한다. 결과를 모를 때 오류와 기존 입력을 유지하고 같은 작업의 최신 결과부터 다시 읽는다. 처음 한 번 읽은 목록을 저장 확인에 재사용하지 않는다. verify: main IPC 응답을 지연시킨 읽기/삭제 경쟁 e2e.
4. 도구 줄의 실제 높이를 반영해 보조 패널을 배치하고 헤더/닫기를 유지한다. native 웹 화면은 sticky 헤더 아래의 실제 가시 영역으로 자른다. 작은 화면의 사이드바를 초기 포커스/Tab 순환/Escape/복귀/배경 inert가 있는 drawer로 제공한다. verify:900px wrap·320 CSS px·키보드·모달 뒤 단축키·native bounds.
5. 독립 리뷰·핵심 회귀 변이·전체 검사 후 GC·문서·커밋·승인된 기능 브랜치 push. 이전 점수95를 자동 승계하지 않는다. 보조기술/실제 계정/기기 미검증은 별도로 남긴다.

## 실패/수명

- 이중 입력: lock·fieldset disabled와 main 멱등 계약 유지. 저장 완료 전 새 편집을 겹치지 않는다.
- 다시 시도: 입력 snapshot 보존, 성공/실패 후 최신 목록 재조회. 결과 불명 실행을 자동 재전송하지 않는다.
- 취소·뒤로·닫기: 닫기는 실행 중인 workflow/예약 취소가 아니며 초안만 메모리에 남긴다. drawer 닫기는 실행 없음. 앱 종료/renderer 재시작은 초안 복원 없음.
- 선택 소멸: 버리기 확인 중 대상 template/schedule가 삭제되면 최신 id 확인 뒤 오류·기존 입력 유지. 일감 삭제 후 늦은 응답은 unmount 수명으로 차단.

## 기준

A1: WCAG2.2의 이름/키보드/포커스/확대와 리플로를 웹 콘텐츠에 적용. 320 CSS px reflow와200%시험을 동일한 인증으로 표현하지 않는다. https://www.w3.org/WAI/WCAG22/Understanding/reflow.html
A2: APG modal 초기 포커스·내부 Tab·Escape·논리적 복귀·배경 inert, https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/ . 브라우저 tabs는 https://www.w3.org/WAI/ARIA/apg/patterns/tabs/ . U1: 상태·복구·사용자 통제. 기존 토큰·24CSSpx 이상 대상 크기/정렬 관계는 실제 화면과 회귀로 확인한다. 전체 접근성 인증·참여자 연구는 수행하지 않는다.

늦게 도착하는 옛 응답은 요청 번호/세대로 버리는 시험을 추가한다. 실제 대조 안 함: 실제 공급자·OS 스크린리더·실제 계정은 이번 가짜 실행기의 보장에 포함하지 않는다. Electron native view·로컬 HTTP·임시 Git·실제 journal은 실제 프로그램과 대조한다. 캐시된 기존 편집 대상이 삭제되면 저장 시 최신 목록으로 확인하고 재생성하지 않으며, 새 작성과 기존 편집 origin을 보존한다. verify: 기존 workflow/schedule 편집 초안의 대상 삭제 후 저장이 오류로 남고 journal에 부활하지 않는다. 외부 삭제와 저장 사이의 원자적 transaction까지 제공한다고 주장하지 않는다.

## 범위별 증거 지도

최종 전체 검사와 최종 캡처 후 판정한다. 시험 이름은 검사 경로이며 시험의 존재만으로 통과라고 세지 않는다.

| 주요 화면/과업 | 검증 경로 |
|---|---|
| 사이드바·일감·탭·분할·터미널 | responsive,uiux-polish,layout-align,keys,activity,split,sidebar 관련 기존 e2e + 신규 drawer/layout |
| 대화·허락·중지·Codex·되감기·분할 | chat,chat-codex,chat-entry,chat-layout,responsive 기존 e2e |
| 전체 보기·목록·열기 | overview 기존 e2e |
| 검색·보관 대상·가림·정확한 턴 | conversation-search 및 archive 관련 기존 e2e |
| 설정·단축키·최소 창·복구/백업 | settings,uiux-polish,responsive,backup,archive-ux 기존 e2e |
| 파일/Markdown/PDF·자료 확인 | workspace-tools 기존 e2e |
| GitHub 상태·PR·확인창·입력 보존 | git-workflow 관련 단위/기존 loopback e2e |
| 작업 흐름·중단·예약·결과 열기 | workflows,schedules + 신규 panel-ux/panel-origin |
| worktree 생성·정리·실패/변화 | worktrees 및 strict cwd 실제 프로그램 시험 |
| 브라우저 탭·폼·복원·캡처·보관 | browser-tabs,browser-tab-lifecycle,workspace-tools + sticky native bounds |

## 관찰 → 조치

| 심각도 | 관찰과 영향 | 조치·검증 계획 |
|---|---|---|
| HIGH | nested 확인창 뒤 전역 키가 뒤 일감/탭을 변경 |39단계에서 즉시수정, 정리 확인창 실제키/변이, 이번 전체에서 재확인 |
| MEDIUM | 작업 흐름의 늦은 poll이 삭제 뒤 옛 목록을 다시 표시 | 요청 version·후속 재조회, 지연 IPC e2e·변이 |
| MEDIUM | 작업 흐름/예약 패널 닫기 또는 일감 전환에서 미저장 입력 소실 | 일감별 메모리 초안·버리기 확인, 실제 전환·journal 미저장 시험 |
| MEDIUM | 삭제한 기존 편집 대상이 캐시 초안 저장으로 부활 | origin 보존·저장 전 최신 대상 확인·없음 오류, 정확 회귀 시험 |
| HIGH | 작은 화면 sidebar overlay에 키보드 진입·닫기·복귀 수단 미흡 | modal drawer focus/inert/Tab/Escape·기존 메뉴 회귀 |
| MEDIUM |900px 도구 줄 wrap을 패널 top 상수가 반영하지 못함 | 실제 toolbar 높이 기반 배치·sticky header, 좌표/과업 회귀 |
| MEDIUM | native 브라우저가 스크롤된 sticky 헤더를 덮을 위험 | visible intersection에 헤더 bottom 포함, native bounds 대조 |
| LOW | 작업 흐름 제목이 부모 패널 제목과 중복 | 하위 중복 제목 제거, 제목/제어 위계 화면 확인 |

화면 캡처 도구는 Electron zoom에서 잘리는 Playwright capture 대신 native capturePage를 사용하고2번 paint를 기다린다. 도구의 잘린 그림을 제품 결함으로 오판하지 않는다.

## 실제 재현·수정 기록

초안 소실·삭제 뒤 건너뛴 재조회는 기존40 빌드에서 실제 RED2개(`/tmp/taskminal-uiux-red.log`), 도구 줄 겹침/서랍 미구현은 RED3개(`/tmp/taskminal-uiux-layout-red.log`)였다. 이후 관련19개 중18개가 통과했고, 헤더 시험1개는 CSS 패딩16px를0으로 오인한 판정이었다. 초기 헤더 좌표를 떠 두고 충분한 스크롤 뒤 같은 위치와 완전한 가시성을 확인하도록 바로잡았으며 실제 위치105px 유지로 통과했다. 제품 CSS는 이 이유로 바꾸지 않았다.

새로운 native 헤더 교집합 시험은 실제 웹 영역이14.5px로 압축된 상태를 발견했다. 공통 stylesheet가 같은 specificity의 브라우저 flex/min-height 규칙을 덮은 결과다. 컴포넌트 하위 selector로 지정해 가시 영역을 보존하고, 실제 sticky header 뒤로 들어간 부분은 native bounds에서 제외했다. 화면 이동/수집은 스크롤·layout 반영을 기다린 뒤 native action을 요청한다. 기존 sandbox/키보드/F6/캡처/zoom을 포함한 브라우저 관련15개가 최종 통과했다(`/tmp/taskminal-uiux-browser-green4.log`). 이 시험의 이전 실패·진단 로그도 보존했다.

독립 리뷰의 MEDIUM 두 건도 수정했다. (1) 초기 필터가 빈 상태에서도 Esc를 소비해 서랍이 닫히지 않음: 내용이 있으면 지우고, 빈 경우 modal로 넘겨 닫기/포커스 복귀. (2) 캐시한 기존 편집 대상이 삭제된 뒤 Save로 부활함: new/edit origin과 현재 대상 조회·일감/수명 guard로 차단. 조회 뒤 저장 사이 외부 삭제를 원자적으로 막는 CAS는 기존 API에 없어 제공한다고 주장하지 않는다. 늦은 저장/삭제는 같은 버전의 캐시만 정리하고 새 초안을 지우지 않는다.

실제 화면 확인: `test-results/uiux-final-workflow-medium.png`에서900px 도구 두 줄과 패널 시작선/폼 위계, `test-results/layout-ux/drawer-320-css.png`에서320 CSS px 서랍·닫기·배경 가림을 직접 열어 봤다. 최종 전체 후 추가 캡처와 검증 결과를 아래에 기록한다.

최종 포커스 리뷰에서 A→B→A 선택 왕복 중 지연된 native show 응답이 이전 포커스 요청을 다시 유효하게 만드는 MEDIUM을 발견했다. 실제 IPC show 응답을 붙잡아 왕복 뒤 focus call1회가 실행되는 RED를 확인했다(`/tmp/taskminal-uiux-focus-red2.log`). reveal은 선택 ID와 컴포넌트 수명 외에 요청 시작 version도 각 await 뒤 비교하도록 고쳐 GREEN이었다. 첫 시험은 IPC 이름을 추측해 hold 자체가 걸리지 않았으므로 재현 근거로 세지 않고, 실제 `src/shared/ipc.ts` 이름으로 고친 두 번째 실패를 근거로 사용한다.

검증 도구 실수도 구분한다. draft의 임시 타입 점검이 actual node tsconfig의 DOM iterable 제약을 놓쳐 실제 typecheck에서 새 test NodeList spread를 발견했고 Array.from으로 고쳤다. 한 편집 스크립트는 실제 CSS 문자열과 맞지 않아 assert로 멈췄지만 뒤 shell 줄의 이전 빌드 시험은 진행됐다. 그 실패를 수정 후 검사로 세지 않고 실제 문자열을 읽고 다시 수정/빌드했다. 로그의 실패와 최종 통과를 구분하며 종료 코드로 판정한다.

## 최종 시각 확인에서 추가한 반응형 수정

첫 최종 전체 `/tmp/taskminal-uiux-full.log`는 종료0·단위1,141·e2e315(패키징1 skip)였다. 하지만 이후 실제로 연 `test-results/uiux-settings-before-reflow.png`에서320 CSS px 설정의 메뉴가200px를 차지해 본문이 글자 단위로 줄바꿈되는 HIGH를 확인했다. 넘침이 없다는 자동 판정만으로는 읽을 수 있는 화면을 보장하지 못했다. 기존 전체 통과를 제품 완료 판정으로 쓰지 않고 설정을 별도로 수정하고 실제320px에서 본문 폭·읽기·메뉴 전환·검색·닫기를 재검증한다.

전체 보기 필터도 기본 브라우저 서체/21px 높이로 다른 제어보다 작음을 `test-results/uiux-overview-before-controls.png`에서 관찰했다. 기존 토큰·서체·배경/선과24CSSpx 이상의 누르는 영역으로 맞추고 실제 검색/필터 시험에 최소 hit-area 확인을 추가했다.

이 추가 변경 후 최종 전체 결과는 아래에 별도로 기록한다. 범위가 바뀐 것이 아니라 승인된 전체 주요 화면 검토에서 발견한 문제다. GC에는 화면 검토를 첫 전체 실행 전에 끝내지 않아 재실행이 생긴 점을 기록하고, 새로운 settings-reflow 회귀는 단순 scrollWidth 대신 가용 본문 폭과 실제 읽기 과업을 검사한다.

추가 설정 수정은 `src/renderer/settings/SettingsView.tsx`와 `src/renderer/settings/settings-responsive.css`다. 700px 이하에서는 기존 검색 입력을 접어 두고 native category select·검색 열기·뒤로·닫기를 한 줄에 놓는다. 기존10개 category 데이터와 검색 결과를 재사용하고 desktop 탐색은 유지한다. `tests/e2e/settings-reflow.spec.ts`는 실제320 CSS px/200%에서 본문 폭≥뷰포트85%·닫힌 검색에서 본문 높이≥55%·헤딩 폭≥240px와 모든10개 선택·검색·Escape·닫기/뒤로를 확인한다. 화면의 읽기 공간을 검사하며 구현의 padding 숫자를 단정하지 않는다.

독립 설정 리뷰 HIGH/MEDIUM 없음. 관련29개가 통과했고 실제 다크/라이트 `test-results/settings-reflow/settings-320-css-light.png`·`settings-320-css-search.png`를 직접 열어 정상적인 줄바꿈/본문 폭·제어 위계를 확인했다. 검색 화면도 native capture로 바꿔 `test-results/conversation-search-small-light.png`의 전체 모달·검색어·닫기를 확인했다. 이전 Playwright zoom crop을 실제 제품 가림으로 세지 않는다. 새 일감·파일 미리보기·GitHub 확인창·출력 검색·워크트리 캡처도 함께 확인했다.

## UI/UX 판정과 검증 한계

확인한 결함은 수정 후 관련 과업을 통과했다. 전체 제품의 접근성 판정은 **부분 검증**이다. 실제 VoiceOver·한국어 IME·레티나 화면·OS 전경 포커스 전달, 실제 Claude/Codex 계정·GitHub 원격 쓰기와 사용자 Git hooks/NAS는 이번 검증에 포함하지 않는다. 실제 참여자 사용자 테스트·전환율 연구·현장 성능 측정·접근성 인증은 수행하지 않았다. 앞 단계95점을 자동 승계하지 않는다.

웹 child view의 화면 픽셀은 trusted renderer capture에 포함되지 않은 그림도 있으므로 그 그림만으로 native 페이지 합성을 통과 판정하지 않는다. 실제 로컬 페이지 로드/DOM·폼/캡처 결과와 native child bounds·visible 상태를 함께 대조했다. OS 실제 전경 키보드 전달은 별도 확인이다.

## 실행 선택·회고

| 항목 | 관측 근거·반영 |
|---|---|
| 모델 선택 | 기본 parent가 통합/최종 검증. gpt-6.1-sol medium이 한정된 renderer/레이아웃·설정 초안과 과업 시험, sol high가 비동기 수명·삭제 대상·포커스 세대/설정 독립 리뷰. 고위험 시나리오를 분리한 리뷰에서 실제 MEDIUM을 발견했고 parent가 최종 반영·검증 |
| 총토큰·실행 비용 | parent+worker usage 합계는 미측정이라 절감률/최적 판정 없음. 실제 첫 전체8분 통과 후 설정 화면 결함 발견으로 추가 전체가 필요했다. 관련 화면 먼저 확인했다면 줄일 수 있었으며 새 reflow 가드/실제 캡처로 반복을 방지 |
| 위임 방식 | 추가 worker2개, 파일 소유·임시 초안과 실제 통합을 분리하고 build/e2e 슬롯을 직렬 배정. 같은 전체 레포를 중복 구현하지 않고 UI와 안전성 리뷰로 구분. worker 커밋/push 없음 |
| 판단/도구 오류 | 잘린 zoom 이미지와 패딩0 가정은 제품 결함으로 세지 않음. 새 test DOM iterable 오류·IPC 채널 오기·CSS 원문 assert 실패 후 이전 빌드 실행은 각각 수정하고 실제 실패/성공 로그를 구분 |
| 도구화 | 초안 메모리·dirty/origin·저장/삭제 캐시 identity·요청 version/재조회·modal focus/inert·measured toolbar/header·CSS 우선순위·native reveal version을 실제 가드로 옮김. 단순 설명 문구 강화 대신 과업 e2e·정확 회귀 변이로 확인 |
| 추가 개선 | 설정 검사는 넘침만으로 충분하지 않아 가용 본문 폭/실제 category 과업 추가. 전역 규칙은 사용자 선택 없이 승격/병합하지 않음. 실제 계정·기기·보조기술과 외부 삭제 CAS/외부 writer 봉쇄는 별도 범위 |

UI/UX 핵심 변이 총12개 모두 검출·원복: 초안2·건너뛴 읽기·삭제 edit2·빈 필터Escape·도구 줄 높이·native header clip·브라우저 CSS 우선순위(`/tmp/taskminal-uiux-mutations.log`,91초), native focus ABA(`/tmp/taskminal-uiux-focus-mutation.log`,5초), 설정 본문 reflow·전체 보기 hit-area(`/tmp/taskminal-uiux-reflow-mutations.log`,14초). 컴파일 실패·채널을 잘못 잡은 실패는 검출 수에 포함하지 않는다.

추가 전체 `/tmp/taskminal-uiux-final-full.log`는 단위1,141 통과 뒤 e2e314통과/2실패/1skip, 실패2개의 자동 재시도도 실패해 종료1이다. 백업 복원 시험의 실패는 데이터 안전 로직이 아니라 넓은 설정에서 compact 닫기 단추가 공통 `.icon-button` display에 의해 함께 노출된 실제 회귀였다. 숨김 selector를 settings 범위로 고정하고 새 reflow 시험에 넓은 창 복귀 뒤 닫기 단추1개/desktop 검색 포커스를 추가했다. UX200% 시험은 native zoom 도착 전 `.isVisible()` 한 번으로 고른 desktop 메뉴가 그 사이 숨겨져 기다리는 동기화 오류였다. helper는 제한된5초 동안 현재 보이는 제어를 다시 찾아 같은 category를 선택하며 개별 대기는750ms로 제한한다. 숨긴 제어의 DOM click으로 우회하지 않는다.

문제가 난 백업 복원·UX200%와 좁은/넓은 설정3개가 모두 통과했다(`/tmp/taskminal-uiux-settings-fix.log`,4.1초). CSS 표시 범위를 이전 것으로 바꾼 정확한 변이도 새 wide close 검사에서 검출·원복했다(`/tmp/taskminal-uiux-wide-mutation.log`,10초). 따라서 UI/UX 변이는 총13개다. 위 실패를 최종 성공으로 덮지 않고 별도 기록하며 수정 이후 전체 결과를 따로 기록한다.


## 최종 전체 결과와 GC 진단

`/tmp/taskminal-uiux-final2-full.log` 종료0: typecheck·경계·단위1,141·e2e316 통과, 패키징 전용1 skip. E2E462초. 앞선 종료1과 재시도 실패를 위 기록에 보존했다. 이번 최종 실행에는 설정의 넓은/좁은 화면·검색/메뉴 전환, 백업 복원, UX200%와 모든 신규 초안/서랍/브라우저 회귀가 포함된다.

마지막 읽기 전용 GC `/tmp/taskminal-uiux-gc.json`: 승격 후보 r89439e, 승격 후 재발 rd0536c, 병합 후보 없음, Electron 규칙 감사 toolable0, 프로젝트 state 없음. 정확한 회귀를 깨뜨리는 변이13개와 실제 Electron/body width/가림 bounds/현재 IPC 이름 대조로 대응했다. 전역 판단 규칙의 생성·승격·병합·삭제는 자동 반영하지 않았다. Codex transcript 수집기의 미지원 형식은 앞 단계에서 확인했으므로 같은 실패 수집을 반복하지 않았고, token/훅 통계는 미측정으로 남겼다. 사용자 지시에 따라36~40 각 단계 GC와 이 전체 UI/UX의 GC를 별도로 완료했다.
