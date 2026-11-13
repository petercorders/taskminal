# Taskminal 36~40 — Orca 비교 후속 다섯 영역

일자: 2026-11-14. 상태: 2026-11-14 승인된36~40 구현·단계별 GC·커밋 완료, 전체 UI/UX 개선·검증·GC 완료. 기능 브랜치 `stage-36-40-orca-followup`, main 미병합. 최종 단위1,141·e2e316·UI 변이13, 상세 `docs/stages/41-whole-app-uiux.md`.
사용자 요청: Orca 대비 다음 개발 5개 제안 → Electron 구현 → GC → commit/push.
push는 승인됨. main 병합·출시 게시·실제 공급자 메시지 전송·NAS 접속·실제 데이터 폴더 변경은 포함하지 않는다.

## 현재 근거와 문제

사용 상황은 여러 일감에서 Claude/Codex 대화·검토·셸·웹 확인을 반복하는 개발자다. 기존 기능 31~35는 전체 보기·계정·GitHub·웹/파일 미리보기를 제공하지만 다음 흐름은 아직 수작업이다. 실제 사용자 인터뷰·사용 빈도/매출 데이터는 없으므로 아래 우선순위는 코드와 설치 제품 계약에 근거한 제안이며 수요 검증 완료가 아니다.

관찰 범위: Taskminal 1ca0526의 src/shared/types.ts, src/shared/global-find.ts, src/main/chat/chat-store.ts, src/main/cli-server.ts, src/main/worktree.ts, src/main/workspace-browser.ts, src/renderer/WorkspaceBrowser.tsx. 파일 목록과 진입점·타입을 교차 확인했다. graphify-out/graph.json은 없으며 이번 범위에서 새 그래프는 만들지 않는다.
Orca 근거는 설치된 CLI에서 2026-11-14 읽은 최신 안내다. `/tmp/taskminal-orca-cli-current.txt`, `/tmp/taskminal-orca-automations.txt`, `/tmp/taskminal-orca-browser.txt`, `/tmp/taskminal-orca-orchestration-help.txt`. 경쟁 제품 모든 기능/모든 버전을 감사한 것은 아니다.

| 후보 | 관찰 사실과 차이 | 선택 이유·반대 근거 | 현행/대안 |
|---|---|---|---|
| 36 대화 기록 통합 검색·이어가기 | Orca Agent Session Search는 사용자/에이전트 대화·필터·resumeCommand 제공. Taskminal은 터미널 출력 검색과 pane별 ChatStore는 있으나 전체 대화 검색 경로가 없다 | 과거 결정/수정 위치를 찾는 비용 감소 추론. 로컬 기록만 검색하므로 외부 CLI에서 한 대화까지 찾지는 못함 | 각 일감 열기 또는 기록 파일 수작업 검색 |
| 37 재사용 가능한 에이전트 작업 흐름 | Orca orchestration에 run/task/dispatch/gate/worker 상태가 있다. Taskminal은 CLI chat new/send/wait가 있으나 저장된 실행 단계·의존·실행 이력 UI는 없다 | 구현→검토 같은 반복 순서를 재현. 자동화의 실제 수요는 미검증이고 자동 승인/자동 병합은 제외 | CLI 스크립트 또는 빠른 명령 여러 번 |
| 38 예약 실행·결과함 | Orca automations는 예약 prompt·실행 이력·실행 전 조건을 제공. Taskminal quickCommands는 수동 실행 | 반복 점검을 앱 안에서 추적. 앱이 꺼졌을 때 실행하지 않는 한계가 있으며 OS daemon은 후속 | macOS 스케줄러/수동 실행 |
| 39 worktree 수명 관리 | Orca list/show/parent/set/rm 지원. Taskminal은 새 일감에서 addWorktree만 제공 | 흩어진 checkout을 찾아 열고 안전하게 정리. 삭제 경계가 고위험이므로 dirty/사용 중/root/locked는 차단 | git worktree list/remove 수작업 |
| 40 일감별 브라우저 다중 탭·선택 복원 | Orca tab create/list/switch/close 및 재시작 lazy load 제공. Taskminal은 일감당 단일 Entry와 메모리 URL | 앱/문서/테스트 페이지를 오가며 폼 상태를 유지. View 자원과 URL 저장 개인정보 위험 때문에 상한·선택 저장 필요 | 외부 브라우저/주소 덮어쓰기 |

파일 편집기·이슈 트래커 연동·플러그인 시스템도 후보이나 저장 충돌·외부 OAuth·플러그인 권한이라는 별도 제품 경계가 커 이번 5개에서 보류한다. 기존 외부 편집기·일감 메모를 유지한다. 임의 점수/시장 우위/매출을 주장하지 않는다.

## 가장 위험한 가정과 최소 검증

가정: 작업 흐름/예약이 기존 단일 대화의 계정·승인·중단 의미를 지키면서 반복 실행할 수 있다.
대상은 임시 userData와 임시 Git/로컬 HTTP/가짜 claude·codex 프로세스다. 실제 고객 모집·유료/운영 실험은 안 한다.
변화는 반복 단계의 생성→실행→허락 대기→완료/실패→재시도/중단을 저장된 run으로 추적하는 것이다.
성공 조건: 같은 요청이 두 번 실행되지 않음, 이전 세대 응답이 새 run을 덮지 않음, 중단/재시작 후 불명 결과를 자동 재전송하지 않음, 기존 계정 바인딩 유지. 이 중 하나라도 깨지면 자동 실행 연결을 중단하고 설계를 수정한다. 설치 실제 CLI 대화/과금은 대조 안 함으로 남긴다.
검증 한도는 다섯 단계별 단위/통합·e2e·변이 batch 및 최종 전체 회귀 한 번, 실패/새 변경이 있으면 관련 재검증이다. 수요·사용자 만족도 검증은 판정 보류다.

## 기반·브랜치·환경

현재 작업 위치 ~/orca/workspaces/taskminal/taskminal, stage-31-35-workspace / 1ca0526, 미커밋 변경 없음. origin/main c6ed6dd를 fetch·트렁크 확인했고 기존 브랜치의 PR 없음.
기존 31~35 두 커밋은 아직 main에 없다. 승인 후 origin/main에서 stage-36-40-orca-followup을 만들고 35e27ff·1ca0526을 순서대로 가져와 기반으로 삼는다. 원 브랜치는 유지한다. push 대상은 origin/stage-36-40-orca-followup이며 이전 의존 커밋도 포함됨을 보고한다. main으로 직접 push하지 않는다.
프리뷰 앱은 패키징본이므로 소스 watch가 아니다. 실행 중 사용자 앱/셸을 종료하지 않는다. 검증은 TASKMINAL_USER_DATA 임시 폴더만 사용한다. /Applications 설치·사용자 계정/전역 CLI 설정 변경 없음.
Pages workflow는 main의 site/** 또는 workflow 자체 변경에만 반응한다. 기능 브랜치 push는 릴리스를 게시하지 않는다. 실제 GitHub 쓰기 테스트 자원은 만들지 않고 요청된 최종 기능 브랜치 push만 한다.

## 구현 순서 → verify

### 36 대화 기록 검색
- 별도 '대화 기록 찾기' 진입과 현재/전체 일감·에이전트 필터, 사용자/assistant 본문·가린 snippet·결과 개수/잘림 안내.
- main이 허용된 pane ID로만 ChatStore를 읽는다. 파일 경로는 renderer에서 받지 않는다. 검색·파일·결과 상한과 취소 세대, 손상/읽기 오류와 결과 없음 구분.
- 결과는 정확한 일감/탭/pane/턴으로 이동한다. 열린 뒤 대상이 사라지면 안내하며 잘못된 대화로 이동/자동 전송하지 않는다. 보관된 일감은 복원 확인 후 이동.
- verify: 다중 일감/에이전트·보관·삭제 대상·가림·손상/과대 기록·늦은 응답 단위 및 실제 저장 파일 e2e, 키보드/200%.

### 37 에이전트 작업 흐름
- 로컬 workflow 템플릿(이름·단계·Claude/Codex·프롬프트·선행 단계)과 실행 이력/세부 상태. 10단계 상한, 순환 의존 거부.
- 첫 버전은 실행 순서에 따라 한 번에 한 단계 실행. 독립 병렬 실행/자동 worktree 분리는 후속이며 병렬이라고 표시하지 않는다.
- 전용 대화 pane과 계정 바인딩을 사용하고 허락/질문은 기존 카드로 사용자가 처리한다. 앞 단계 결과는 가린 비신뢰 참고 자료로 다음 단계에 전달한다.
- main의 run/step ID·세대·잠금·원자적 기록으로 중복을 막는다. 중단은 run 소유 대화만 멈추고 기존 사용자 pane은 건드리지 않는다. 실패 단계 재시도는 명시적이며 완료 단계를 다시 실행하지 않는다.
- verify: 가짜 claude/codex로 2단계 진행·허락 대기·실패·중단·중복·닫힌 대상·재시작·계정 유지. 외부 실제 공급자 동작은 대조 안 함.

### 38 예약과 결과함
- workflow를 일감에 연결해 앱 실행 중 매일 지정한 로컬 시각 또는 간격으로 실행, '지금 실행'·일시정지·다음 실행·결과 이력 제공. 기본 꺼짐이며 저장만으로 실행하지 않는다.
- 예약 tick의 중복/진행 중 run 겹침을 건너뛰고 이유를 남긴다. 앱 종료/절전 동안 놓친 실행은 몰아서 재생하지 않고 '놓침' 후 다음 미래 시각으로 이동한다.
- 로컬 시간/시간대·DST·시계 역행·일감 보관/삭제·workflow 변경을 처리한다. OS 백그라운드 서비스/cron 문법/네트워크 scheduler는 제외.
- verify: 주입 시계로 시각/시간대·절전/재시작·중복 tick·pause·진행 중·삭제를 단위 시험, 가짜 실행기로 UI 결과함 e2e. 실제 예약은 사용자 앱에 만들지 않는다.

### 39 worktree 관리
- 저장소별 실제 worktree 목록, 브랜치·HEAD·root/locked/prunable·연결된 일감·dirty 상태, 기존 checkout에서 일감 열기와 명시한 base로 새 checkout 만들기.
- 정리는 git worktree remove(강제 없음)만. root·현재 앱이 사용 중인 일감/자식 cwd·dirty/untracked·locked·등록 안 된 경로 차단. 브랜치 자동 삭제 없음.
- 삭제 확인은 경로/branch/HEAD를 고정하고 실행 직전 다시 조회한다. 경로·저장소·소유 경계와 argv 실행을 검증한다.
- verify: 임시 실제 Git 저장소로 추가/목록/열기/clean 삭제·dirty/untracked/locked/root/확인 뒤 HEAD 변경·실패 후 재조회. 사용자 실제 checkout은 삭제하지 않는다.

### 40 브라우저 탭
- 일감별 최대 6개 탭·새 탭/전환/닫기·제목·로딩/오류. taskId/tabId로 native view를 식별하고 보이는 탭만 attach한다.
- URL 저장은 명시적으로 켜는 옵션. 기본은 저장하지 않는다. 켠 경우 http(s)·자격증명 없는 가린 URL/선택 탭만 저장하고 재시작 시 사용자가 연 탭만 lazy load한다. POST/폼 값·캡처 초안은 복원하지 않는다.
- 계정 쿠키는 기존 일감 partition 유지. 현재 선택/캡처는 tabId+navigation 세대로 묶어 다른 탭/페이지에 첨부하지 않는다. 닫은 탭은 늦은 응답으로 재생성하지 않는다.
- verify: 로컬 페이지 둘의 상태 보존·정확 탭 캡처·닫힌 대상·상한·설정 off/민감 URL·재시작 lazy load·모달 가림·F6 focus 요청·배율 e2e. 실제 OS 키보드 전경/Retina/VoiceOver는 별도 확인.

## 공통 실패·수명 계약

| 상황 | 처리와 시험 |
|---|---|
| 결과를 모를 때 | run/step ID·상태·마지막 확인을 표시. 전송 수락이 불명이면 결과 확인 필요로 남기며 자동 재전송하지 않는다. worktree는 실제 list/HEAD 재조회로 이미 생긴 자원을 확인한다. |
| 다시 시도 | 검색/조회는 현재 설정과 새 세대로 다시 읽는다. workflow는 실패 단계만 사용자 조작으로 새 attempt, 불명 단계는 기록/대화 확인 후 결정. 예약은 다음 미래 실행만. |
| 이중 입력 | 저장소/run/예약별 잠금과 멱등 요청 ID. UI busy와 main 검증 모두 유지. 같은 프레임·두 renderer IPC도 하나만 실행하는 시험. |
| 취소·뒤로·닫기 | 검색/미전송 draft만 버린다. 패널 닫기는 실행 취소가 아니며 실행 결과함에서 추적한다. 중단 버튼은 run 소유 프로세스만 멈춘다. Git 시작 후 취소로 rollback됐다고 표시하지 않는다. |
| 대상 소멸 | 삭제할 대상은 id로 재탐색하고 저장/전송 내용은 확인을 연 순간의 snapshot. 삭제/보관된 일감은 새 단계·예약을 시작하지 않는다. 새로 실행한 run과 이전 capture를 혼합하지 않는다. |
| 읽기·쓰기 겹침 | 쓰기 시작/완료 때 요청 번호·세대를 증가시켜 늦게 온 옛 응답이 새 값을 덮지 않게 한다. |
| 부수 요청 | 조회/예약 tick은 한 번에 하나, 안 보일 때 UI 폴링 중단. 쓰기 뒤 건너뛴 요청은 앞 요청이 끝난 뒤 다시 한 번 조회한다. |
| 초기 값 갱신 | 처음 한 번 읽은 설정을 캡처하지 않고 매 실행 현재 일감·계정 바인딩·템플릿 버전을 확인한다. |
| 연결 중간 실패 | 준비하는 중 글자와 15초 시간 한도. initialize/resume 중간 실패는 앞 단계 프로세스/구독 정리 후 새 attempt를 시작한다. |
| 종료 4경로 | 앱 종료·창 닫기·renderer 새로고침·충돌을 각각 시험. main 실행은 renderer 재마운트로 중복 시작하지 않는다. 앱이 죽어 끝 표시를 못 쓴 열린 run/turn은 재시작 때 중단/결과 불명으로 닫고 자동 재실행하지 않는다. 전용 프로세스와 구독을 정리하며 기존 셸 수명 정책을 보존한다. |

## 리뷰·완료 조건

- 새 로직 RED→GREEN, 핵심 회귀 변이 batch 전 예상 시간 안내·목록 --check·원복·재빌드. 전체 typecheck/경계/vitest/e2e 종료 코드 그대로 기록.
- 화면별 실제 로컬 과업·다크/라이트·작은 창/200%·키보드·오류/빈 상태 검토. 기존 95점을 자동 승계하지 않는다. 미검증은 별도 기재.
- 독립 파일/리뷰가 필요할 때만 제한적 위임, 기본은 현재 모델 단일 진행. 토큰 usage 미측정은 절감률로 보고하지 않는다.
- GC는 retro-collect와 진단(승격 후보/재발/감사)을 수행하고 코드 가드/시험 후보는 검토한다. 전역 판단 규칙의 생성/승격은 사용자 선택 없이 적용하지 않는다.
- docs/ideas와 stages36~40/통합검증·개발 진행·메모리 갱신. code-review의 CRITICAL/HIGH 수정 후 검증, 커밋 한국어.
- git diff --cached --stat 확인 후 commit, 승인된 origin/stage-36-40-orca-followup push. remote SHA 일치와 해당 워크플로 발생 여부 확인. main merge와 Release 게시 없음.

## 추가 승인 — 전체 UI/UX

36~40 완료 후 전체 주요 화면을 핵심 과업/반응형/키보드/오류 복구 기준으로 재검토하고 확인된 결함을 개선한다. 단계별 GC 외에 UI/UX 완료 뒤에도 GC를 수행한다. 멀티에이전트와 용도별 모델 사용은 허용됨. 범위를 제한한 UI worker는 gpt-6.1-sol medium, 고위험 읽기 전용 조사/리뷰는 gpt-6.1-sol high 또는 지원되는 상위 모델을 사용하며 실제 선택과 근거를 기록한다. 총토큰은 미측정일 때 절감률을 주장하지 않는다.
