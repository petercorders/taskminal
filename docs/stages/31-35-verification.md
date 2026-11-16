# 31~35단계 통합 검증·리뷰

요청: Orca 비교에서 찾은 다섯 영역 전체 개발. 2026-11-13 계획 승인 후 브랜치 `stage-31-35-workspace`에서 진행했다. 기준 main은 `c6ed6dd`.

## 통합 결정

- 전체 보기·계정·GitHub·브라우저·파일은 기존 App와 공통 preload/IPC를 공유해 함께 통합했다. 단계별 모듈·결과 문서는 분리하고 전체 회귀는 같은 통합 상태를 대상으로 수행한다.
- 브라우저/파일/GitHub는 작업 도구의 일감 보조 화면이다. 넓은 창은 대화 옆, 좁은 창은 본문 전체를 사용한다. 기존 터미널 kind와 프로세스 수명 모델을 바꾸지 않는다.
- 낮은 창에서는 도구 메뉴를 사이드바로 옮겨 본문 높이를 보존한다. 520 CSS px 이하에서는 사이드바를 접고 도구 선택·전체 보기·일감 목록 진입을 유지한다.
- 300px 이하 분할 대화는 여백과 보조 경로·모델 표기를 줄여 보내기·셸·TUI를 유지한다. 계정·한도·모델 전체 정보는 넓은 화면/계정 화면에서 확인한다.
- 상태 파일을 처음 읽을 때도 main의 현재 상태를 채운다. 첫 편집 전 파일/브라우저 IPC가 일감을 찾지 못하던 연결 문제를 고쳤다.
- `src/main/workspace-browser.ts`와 `src/main/workspace-ipc.ts`는 의도적으로 실제 Electron e2e에서 검증한다. Node에서 Electron을 가짜로 바꾸는 시험은 실제 격리·native View·창 수명·senderFrame 경계를 검증하지 못한다. 순수 로직·파일·공급자 프로토콜·Git 작업은 단위/실제 자원 통합 시험을 별도로 둔다.

## 검증 기록

- 첫 전체 실행: 단위 통과, e2e 5건 실패. 보관함 빠른 키 입력 초기 준비, 확대 직후 전체 보기 진입, 640×400 분할 대화, 메모/기록 본문 높이, preload 키 목록 갱신을 확인했다.
- 보관함 fixture는 기준 시간을 한 번만 만들고 검색 포커스를 기다린다. 전체 보기 확대 시험은 실제 CSS 폭이 바뀐 뒤 보이는 진입점으로 이동한다. 이는 기능을 빼거나 요구 조건을 낮춘 변경이 아니다.
- 작은 창은 새 도구 줄의 높이 때문에 기존 본문과 대화 보내기가 가려졌다. 사이드바 메뉴와 좁은 pane 배치로 고친 뒤 원래 180px 본문·버튼 전체 노출 조건 그대로 확인했다.
- 보안 시험의 preload allowlist에 accounts/workspace/gitWorkflow만 추가했다. require/process 부재·실제 OS sandbox 확인은 유지한다.
- 관련 31개 e2e와 전체 회귀(단위 1,017·e2e 280)가 통과한 뒤 사용자 지정 비밀값 경로를 추가 보강했다. 마지막 재검증 결과는 아래에 기록한다. 첫 로그 `/tmp/taskminal-workspace-full-check.log`, 최종 로그 `/tmp/taskminal-workspace-final-check.log`.
- 전체 보기 변이 3개, GitHub 변이 4개, 계정/파일/브라우저 변이 11개와 사용자 지정 가림 변이 2개, 총 20개를 모두 검출하고 원복했다. `/tmp/taskminal-overview-mutations.tsv`, `/tmp/taskminal-gitflow-mutations.tsv`, `/tmp/taskminal-workspace-mutations.tsv`, `/tmp/taskminal-custom-mutations.tsv`.
- 계정 5개 보호(환경·진행 바인딩·분기·손상·TUI), 0%·초 단위, 폴더 밖 경계·크기·첨부 변경·브라우저 배율을 다룬다. 실제 과거 실패를 재현한 변이와 비슷한 변이를 혼동하지 않는다.
- GitHub 확인창의 초기 포커스 시험을 추가해 기존 구현에서 실패를 본 뒤 취소 버튼 포커스와 닫은 뒤 복귀를 구현했다.
- PDF.js 운영 의존성 감사는 취약점 0개. 개발 의존성의 기존 moderate 항목에 강제 업그레이드를 적용하지 않았다.

## 코드 리뷰

독립 읽기 전용 리뷰와 통합 검증에서 다음을 고쳤다.

| 위험 | 처리 |
|---|---|
| 추가 계정에 기본 API 키/클라우드 인증이 남음 | 직접 실행의 인증·공급자 환경 제거, TUI는 명시적 env allowlist |
| Codex 로그인·조회·대화의 인증 저장 정책 불일치 | 추가 계정은 file 정책을 CLI override와 계정 config에 맞춤 |
| 대화 분기·TUI·로그인 띠가 기본 계정으로 바뀜 | 원 pane 바인딩 승계와 원 계정의 명령 환경 사용 |
| 손상 기록을 초기 상태로 덮어 인증 주체가 바뀜 | 원본 보존·fail-closed, 자동 기본 계정 재개 금지 |
| 검사 후 symlink 교체로 루트 밖 파일을 읽음 | O_NOFOLLOW, 열린 fd와 전후 inode/dev, 루트 재검증 |
| 홈 축약 경로에서 GitHub 동작 실패 | 소유 확인 후 main에서 절대 경로 정규화 |
| 확대 좌표·닫은 웹뷰 재생성·창 종료 리스너 | zoom 변환, 조회 시 생성 금지, 보유 WebContents로 해제 |
| 취소한 앱 종료에서 웹 폼이 먼저 사라짐 | 실제 종료 will-quit/창 closed에서만 뷰와 조회를 정리 |
| 사용자 지정 가림이 새 첨부 경로에 적용되지 않음 | 현재 설정 콜백으로 파일·웹 텍스트 가림, RED→GREEN·e2e·제거 변이 |
| 대용량 텍스트의 무제한 DOM·과대 PDF canvas | 텍스트 2,000줄 단위 보기/첨부, PDF 크기·이미지·canvas 한도 |

현재 확인된 CRITICAL/HIGH는 수정 후 관련 재검증을 수행했다. 실제 공급자/운영 검증을 하지 않은 항목은 통과로 세지 않는다.

## UI/UX 리뷰

UI/UX 리뷰: 부분 검증(로컬 핵심 과업 확인, 실제 보조기술·계정 미검증).
- 목표: 여러 일감을 살피고, 계정 한도를 확인하고, PR 흐름과 웹/파일 자료를 대화에 연결한다.
- 환경: macOS, Electron 45.2.3, 임시 userData, 640×400/900×600/1280×800 및 최소 창 200% 확대, 다크/라이트.
- 기준: 기존 하네스 U1(피드백/복구)·A1(이름·키보드·대비/확대)·A2(병합 확인창 포커스)·G1(macOS 관례)·K1(한국어 안내). 이는 접근성 인증이나 실제 사용자 만족도 점수가 아니다.
- 과업: 카드→정확 pane, 기존 셸 유지, 계정 추가/기본 선택, 실제 0%와 미지원 구별, PR 입력/확인/HEAD 변경 안내, 로컬 웹 탐색/요소/캡처, 파일 범위/변경/PDF 첨부.
- 초기 캡처의 고정 사이드바와 도구 줄 압박을 고치고 compact 화면을 직접 열람했다. PDF는 페이지 내용과 '내용 미전달' 참조 안내를 구별한다.
- 키보드: 일반 DOM 조작·병합 초기 포커스·Tab/Escape·확대 접근을 수행했다. 웹 진입 버튼→실제 IPC의 focus 요청과 F6 핸들러의 앱 focus 요청도 확인했다. 테스트 호스트에서 native 창의 OS 전경 포커스를 확보하지 못해 실제 F6 입력 전달·VoiceOver는 미검증이다.
- 캡처는 `test-results/workspace/`, `test-results/overview-*.png`, 기존 반응형 결과에 남긴다. 네이티브 웹뷰 격리/가시성/배율은 실제 WebContents/View 값을 함께 확인한다.
- 실제 참여자 사용자 테스트: 미수행. 기존 30단계의 95점을 새 기능에 자동 승계하지 않는다.

## 범위·미검증

- Claude 한도 조회는 공식 경로 미확인으로 미지원. 추가 Claude는 Claude.ai 로그인, Console 계정 격리 제외.
- GitHub Enterprise·fork 교차 PR·자동 병합·강제 push는 제공하지 않는다. 실제 GitHub 쓰기 대신 로컬 bare Git과 가짜 gh를 사용했다.
- 브라우저 다중 탭·권한/다운로드·원격 브라우저와 파일 편집/원격 파일 탐색/완전한 CommonMark는 범위 밖이다.
- PDF/바이너리 대화 첨부는 경로 참조이며 내용을 전달했다고 표시하지 않는다. 실제 공급자 계정에서 메시지/첨부를 보내지 않았다.
- 실제 Retina·IME·VoiceOver는 별도 확인 대상이다. 패키징 후 PDF worker는 아래 후속 검증에서 확인했다.

## 하네스 회고

- 현재 모델 유지. 독립 파일 구현과 읽기 전용 리뷰를 추가 worker 2개에 분리한 목적은 시간/독립 검토다. 전체 input/output/cache/reasoning 토큰은 미측정이며 절감률을 주장하지 않는다.
- 전체 문맥 fork 비용과 통합 비용이 발생했다. 다음에는 짧은 파일 계약과 필요한 문맥만 전달할 수 있는지 비교할 수 있으나 이번에 최적이라고 판정하지 않는다.
- 실제로 고친 문제는 테스트/가드로 남겼다. 새 전역 규칙이나 승격은 사용자가 고르기 전 자동 반영하지 않았다.
- GC 읽기 전용 진단: 변이 원칙 r89439e는 승격 후보, 환경 사실 확인 rd0536c는 승격 후 재발 항목. 이번에는 정확한 회귀 변이·설치 CLI/공식 자료 확인과 IPC/격리 시험으로 적용했다. 병합 후보 없음, 규칙 감사의 추가 도구화 지적 없음. 기록 `/tmp/taskminal-workspace-gc.json`.

## 최종 결과

- 최종 소스의 타입·경계·단위 77파일/1,018개 통과. 최종 전체 e2e 첫 실행은 280통과·1실패·패키지 시험 1건 제외, 자동 재시도 1통과로 종료 코드 3(불안정)이었다. 로그 `/tmp/taskminal-workspace-complete-check.log`.
- 실패는 전체 출력 검색의 기능 assertion이 아닌 afterEach 임시 userData 삭제 `ENOTEMPTY`다. 삭제 재시도 5회를 보강했고 기존 assertion은 유지했다. 해당 spec 전체 재검증 5개 통과(24.8초, 종료 0), `/tmp/taskminal-history-cleanup-check.log`.
- 앞선 전체 실행은 단위 1,017·e2e 280·종료 0(`/tmp/taskminal-workspace-final-check.log`). 이후 사용자 지정 가림을 추가해 단위 1개·e2e 1개가 늘었다. 최종 전체 실행을 재시도 없는 통과라고 표현하지 않는다.
- 파일 라이트/다크·계정 라이트·GitHub 병합·PDF·최소 창 200% 캡처를 직접 열람했다. 구현은 공통 App/IPC를 공유하므로 31~35를 한 커밋으로 묶고 단계별 문서로 범위를 구별한다. main 병합·push는 수행하지 않는다.

## 2026-11-13 후속 패키징 검증

- `npm run package` 종료 0. ad-hoc 서명·hardened runtime의 arm64 .app와 정적 검사를 통과했다. 공증된 배포본을 만든 것은 아니다. 로그 `/tmp/taskminal-workspace-package.log`.
- 작업 도구 e2e에 `TASKMINAL_E2E_PACKAGED=1` 실행 경로를 추가해 같은 계약을 실제 .app에서도 검증한다. `TASKMINAL_E2E_PACKAGED=1 npx playwright test tests/e2e/packaged.spec.ts tests/e2e/workspace-tools.spec.ts --reporter=line`: 11개 통과, 12.4초. 로그 `/tmp/taskminal-workspace-packaged-e2e.log`.
- 패키지의 셸/지킴이·한글·파일 범위·사용자 지정 가림·PDF 로컬 worker 렌더/참조 첨부·브라우저 격리/모달/200%·GitHub 확인창을 임시 데이터로 확인했다. 계정/GitHub 쓰기는 기존 가짜 공급자 계약이며 실제 계정을 사용하지 않았다. PDF 화면도 직접 열람했다.
- 실행 경로 분기 후 개발 빌드의 PDF/사용자 지정 가림 e2e 2개와 typecheck도 종료 0. 제품 코드는 변경하지 않아 전체 회귀·변이를 반복하지 않았다. 이전 전체 회귀의 종료 3 이력은 유지한다.
- 공증 history 재조회는 HTTP 403 `A required agreement is missing or has expired`로 실패했다. 이전 제출의 최신 상태를 확인하지 못했다. Account Holder의 계약 확인이 필요하며 서명/공증 release 재실행과 게시를 하지 않았다. Apple 공식 안내: https://developer.apple.com/help/account/access/roles (갱신된 계약은 Account Holder가 수락).
- origin/main을 fetch해 기준 커밋에서 새 변경이 없음을 확인했다. 이 후속 검증은 main 병합·GitHub push를 포함하지 않는다.
