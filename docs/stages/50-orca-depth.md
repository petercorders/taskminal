# 50 — Orca 비교 다섯 영역의 실사용 기능 보강

사용자 2026-11-16 `/harness-run electron 진행해줘`. 기존 자율 진행 지시·작업별 브랜치·본인 에이전트 권한·공개 릴리스 보류를 유지한다. base는 미병합 기능을 포함한 `origin/stage-44-48-orca-workflow`, 새 브랜치는 `feat/orca-depth`. PR도 이 base로 제출하며 기존 앱 누적 커밋을 main에 통째로 병합하지 않는다.

## 범위와 순서 → verify

1. 코드 편집: 코드 전용 편집기를 적용해 구문 강조·다중 커서·찾기/바꾸기·줄 이동과 기존 CAS 저장·충돌 보존을 연결한다. 모델과 undo는 root/path별로 구분하고 메모리/worker를 해제한다. verify: 실제 편집·찾기/바꾸기·파일 이동·다시 열기·충돌 e2e, 기존 원문 경계 시험. 포맷 명령의 임의 실행과 전체 LSP는 자동 허용하지 않는다.
2. worktree 환경 준비: 저장소의 명시적 환경 설정으로 gitignored 로컬 설정 복사와 초기화 명령을 제안·미리보기·실행한다. 원본/대상 경계와 심볼릭 링크를 검사한다. 실행 전에 사용자가 선택하며 명령 stdout/stderr·상태·다시 시도와 취소를 제공한다. verify: 임시 Git, copied config 독립성·tracked/탈출/secret 미노출·명령 실패 후 재시도. 의존성은 checkout별로 설치하고 원본 node_modules를 임의 공유하지 않는다.
3. 협업·감독: 기존 고정 DAG에 실행 중 작업 추가, 실행별 메시지·질문·답변/차단 해제, 작업별 모델/effort를 연결한다. 질문은 worker/task/attempt에 묶고 늦은 답변·다른 실행·중복 완료를 막는다. verify: 동적 의존·실패·대기·답변·재시도와 완료된 작업의 결과 보존, 실제 가짜 공급자 e2e. 공급자 CLI가 지원하는 모델/effort만 실행 인자로 전달한다.
4. 원격 작업: 실시간 바이트 입출력·터미널 크기 변경을 xterm UI와 연결하고 재접속에서 동일 세션을 유지한다. 서버 소유 PTY 수명을 클라이언트 연결 수명과 구분하며 서버 재시작 복구 가능 여부를 명시한다. 기존 로컬 셸 지킴이를 재사용할 수 있으면 영속 세션으로 이어 붙인다. verify: 임시 실제 server/PTY에서 ANSI·입력·resize·disconnect/reconnect 및 서버 재시작 경계. 네이티브 모바일 앱 제작·실제 NAS/SSH 조작은 Electron 범위 밖이다.
5. 확장 기능: 로컬 확장 manifest·검사·설치/제거·활성/비활성·버전 변경 재승인, 명령/패널 기여점을 만든다. 먼저 선언형 패널·안전한 명령/외부 링크만 허용하고 임의 JS·Node 권한은 주지 않는다. verify: 설치 전 미리보기, manifest/schema·경로·권한 거절·중복 설치·비활성·재시작 복원, 실제 앱에서 확장 패널/명령 사용. 임의 JS worker SDK와 공개 marketplace는 후속 별도 보안 범위다.

## 결과·수명·복구 계약

- 결과를 모를 때: request ID와 현재 상태를 표시하고 생성/실행을 성공으로 추정하지 않는다. 저장/설치/준비 요청은 같은 번호로 확인한다. 시험: 완료 후 응답 유실 및 읽기 재확인.
- 다시 시도: 같은 요청 번호는 완료 결과를 재사용한다. 실패한 준비는 이미 만든 파일을 보존하며, 사용자가 남은 결과·명령을 확인하고 새 미리보기·새 요청으로 실행한다. 명령별 자동 재실행은 하지 않는다. 쓰기 충돌(412/CAS)은 최신 기준을 다시 읽되 초안을 보존하고 명시적 저장을 요구한다. 시험: 외부 파일 변경 및 초기화 실패 뒤 복구.
- 이중 입력: main의 작업별 큐와 request ID/attempt fence로 중복 실행을 막는다. 시험: 빠른 두 실행·두 답변·두 설치 요청.
- 취소·뒤로: 패널 닫기는 이미 생성된 checkout·서버 세션을 삭제하지 않는다. 초기화 중단은 소유한 자식 프로세스만 종료하며 결과를 unknown/중단으로 남긴다. 설치 미리보기 취소는 쓰기0. 시험: 확인 취소와 실행 중 닫기.
- 대상 소멸: 확인창에서 고른 일감/경로/worker가 사라지면 실행 직전에 ID·실제 경로·attempt로 다시 확인한다. 시험: 대기 중 삭제/재시도 뒤 늦은 답변.
- 부수 요청: 원격 출력·확장 목록·실행 상태는 보이는 동안만 한 번씩 읽고 늦은 응답을 세대로 폐기한다. 앞 요청이 끝나지 않았으면 후속 갱신은 하나로 합친다. 시험: 숨긴 pane·느린 조회·재열기.
- 처음 한 번만 읽는 값: 설정·manifest 권한·작업 attempt는 쓰기 직전 최신 값을 다시 확인한다. 시험: 미리보기 후 manifest 변경, 이전 답변의 attempt 변경.
- 앱 종료·창 닫기·renderer reload·충돌: 편집 초안은 기존 메모리 수명을 명시하고 자동 디스크 덮어쓰기를 하지 않는다. 실행/환경 준비/확장 설치 기록은 journal로 복원하거나 unknown으로 안전하게 차단한다. 원격 셸은 클라이언트 종료와 분리한다.
- 가짜 대조: 가짜 Claude/Codex로 결과·질문·완료·실패·응답 유실을 시험하고 실제 Git·파일·Node PTY·Chromium을 함께 사용한다. 실제 공급자 계정·다른 OS GUI는 실제 대조 안 함으로 남긴다.

## 검증·분담

이 통합 단계 안에서 영역별 Red→Green·관련 회귀·변이를 실행하고 통합 타입·경계·전체 단위/e2e를 한 번에 확인한다. UI는 실제 캡처·키보드·좁은 창·오류 복구를 확인한다. GC 진단 후 커밋·push·의존 PR을 제출한다. 공통 IPC·preload·앱 연결에 다섯 영역이 함께 걸리므로 검증한 통합 상태를 하나의 코드 커밋으로 보존한다. 공개 릴리스·main 전체 병합·실제 사용자 데이터 변경은 하지 않는다.

시간·품질을 위해 독립 UI 구현 worker 최대2명을 사용한다. worker는 편집기·개발 도구·감독 UI 또는 원격 터미널 UI를 소유하고 commit/push/별도 worker 생성은 하지 않는다. 고위험 실행·경로·프로세스·인증·journal·통합은 부모가 맡는다. 모델은 현재 기본값을 유지하며 총 토큰·비용은 제공 범위만 기록한다.

## 구현·검증 결과

CodeMirror 편집, 환경 스냅샷 준비, 실행 중 단계·메시지·질문·답변·모델, 원격 xterm/resize/서버 재시작 셸 복구, 선언형 로컬 확장을 구현했다. 사용법은 `docs/development-tools.md`, `docs/workflow-supervision.md`, `docs/remote-workspaces.md`.

영역별 native 검증: 편집기 신규4+기존7, 환경·확장6, 감독 신규3+기존6, 원격 신규2+기존2. 실제 Git·파일·Electron·PTY와 가짜 공급자를 사용했다. 신규 guardian 어댑터의 attach 중 출력 순서·fire-and-forget 제어·누락 세션·dispose는 가짜 HostClient 단위2개로 추가 확인했다. IPC installer·server-entry는 실제 Electron/server native 진입점에서 검사하며 핵심 상태·프로세스 로직은 별도 service 단위로 검사한다.

변이 고유13개 검출: 편집기 모델/undo 캐시, 승인 원문 스냅샷, 변경 manifest 승인, 질문 완료 gate, 완료 실행 소유권, 모델 effort 전달, 불명 입력 UUID 재사용, 출력 cursor 전진, 확장 본문 일반 텍스트, spawn 직전 권한·취소 fence, 재시작 로그 상한, 가린 이름 요청 재시도. 최초 통합 batch에서 cursor 미검출1·상수 gate 변이의 타입 오류 판정 불가1은 성공으로 세지 않았다. 시험과 실행 가능한 변이를 보강한 후 최종5개 batch와 취소 변이를 전부 검출했고 모두 원복했다. 로그 `/tmp/taskminal-50-mutations.log`, `/tmp/taskminal-50-mutations-final.log`, `/tmp/taskminal-50-cancel-mutation.log`, 편집기 `/tmp/taskminal-editor-mutation.log`.

리뷰에서 발견한 실행 중복·스냅샷·취소·재시작·가림 후 멱등성 결함을 수정했다. 코드/UI/GC의 근거와 미검증은 `docs/stages/50-review-gc.md`.

통합 전체 검사는 타입·경계·단위1,225 통과, e2e358 통과·보안 API 기대 목록1 실패·패키지 전용2 skip으로 종료1이었다(9.1분). 새 development/stream/resize API 허용 목록이 빠진 시험만 정정했으며 프로덕션 코드는 바꾸지 않았다. 이후 창 시험5개(실제 sandbox·Node 미노출 포함)가 종료0으로 통과했다. 취소 경합 시험1개를 추가한 뒤 전체 단위103파일·1,226개를 다시 실행해 종료0으로 확인했다. 최종 e2e 고유359개 확인이며 전체 실행 자체를 종료0으로 보고하지 않는다. 로그 `/tmp/taskminal-50-full.log`, `/tmp/taskminal-50-full-summary.log`, `/tmp/taskminal-50-window-final.log`, `/tmp/taskminal-50-final-unit.log`.
