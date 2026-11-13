# 39 — worktree 수명 관리

승인 범위 `docs/ideas/orca-next-five.md`. 상태: 구현·검증·GC 완료(main 미병합).
plan-check: 서버 없음 — 실제 Git을 쓰되 모두 임시 저장소·임시 앱 데이터에서 검증한다. 사용자 checkout은 생성·삭제 시험에 쓰지 않는다.

## 동작과 안전 경계

로컬 일감의 워크트리 관리에서 실제 등록 목록·브랜치·HEAD·기본/bare/잠금/prunable·변경/미추적/ignored·연결 일감과 사용 여부를 보여 준다. 일감으로 열기는 등록/저장소 동일성을 검증하고 기존 일감을 선택하거나 새 일감을 만든다. 기본 시작 종류를 따르지만 에이전트 지시를 자동 전송하지 않는다.

새 checkout은 기준 commit/ref·새 브랜치·절대 경로를 명시한다. 기준을 commit OID로 고정하고 request ID+원자적 receipt를 기록한 뒤 Git을 실행한다. 같은 요청은 결과를 조회하며 Git add를 자동 재전송하지 않는다. 생성 이력1000개·전체 registry4096개 한도에서 쓰기를 막고 데이터를 자동 삭제하지 않는다.

정리는 **force 없는 git worktree remove**만 쓴다. 기본/bare/잠금/prunable/미등록·모르는 속성·공유 Git 정보·다른 등록 worktree 포함·추적 변경·미추적·ignored 파일·sparse/skip-worktree/assume-unchanged·사용 중·상태 미확인은 차단한다. 브랜치 삭제·파일시스템 rm 보상 삭제는 없다.

검사 기준은 설치 Git2.47.1의 porcelain -z/실제 임시 Git 결과와 설치 lsof 매뉴얼이다. 별도 git-dir는 첫 등록을 기본으로 보호하고 commonDir의 dirname을 추측하지 않는다. NUL 전체 registry를 읽으며64개로 잘라 안전 결정을 하지 않는다. 최종 삭제는 확인한 commonDir/path/branch/HEAD를 다시 비교한다. 저장소별 canonical commonDir mutex를 쓴다.

Git status는 untracked all·ignored traditional·submodule 변경을 포함한다. 사용자의 status.showUntrackedFiles=no가 Git 자체 제거 검사까지 약화하지 않도록 자식 Git에도 해당 설정을 all로 고정했다. Git 환경 변수로 다른 저장소/index를 가리키지 않게 제거한다. argv로 실행하고 shell 문자열을 만들지 않는다.

## 사용 중 확인·수명

- main은 보관 상태도 포함한 모든 로컬 일감/pane 경로와 pending pty spawn 경로, 셸 지킴이의 실제 live PID cwd를 확인한다. 새 spawn의 첫 await 전에 경로를 등록하고 완료/실패 finally에서 해제한다.
- 독립 리뷰에서 기존 표시용 lsof probe가 제어문자/역슬래시 경로를 이스케이프된 문자열로 돌려 실제 cwd와 다르게 판정함을 발견했다. 삭제 전용 strictLsofCwds는 NUL framing과 요청 PID를 검증하며 모호한 이스케이프·캐럿·제어문자·대체 문자·deleted 표기·누락/중복·경고/프로세스 오류를 거부한다. 정상 특수 경로도 보수적으로 차단한다. 기존 표시용 probe는 유지한다.
- 비동기 cwd 확인 동안 앱 상태/새 spawn이 바뀌면 마지막 synchronous revision 검사에서 정리를 차단한다. 그 검사 직후 같은 JS turn에서 Git을 시작한다.
- 앱 밖 프로세스의 cwd/ignored 파일 쓰기는 이 mutex로 봉쇄할 수 없다. 검사 후 외부 writer 경쟁은 남으며 파일시스템 transaction/외부 fencing을 주장하지 않는다. Git의 최종 일반 clean 검사도 유지한다.
- 패널 닫기·일감 전환은 이미 시작한 Git을 rollback하지 않는다. 열린 확인 대상은 snapshot이며 누르는 순간 최신 목록과 main 실제 상태를 다시 찾는다. 늦은 열기 응답은 AbortSignal·패널 객체·현재 일감으로 버린다. 기존 일감은 id뿐 아니라 cwd snapshot도 비교해 다른 폴더로 바뀐 일감을 선택하지 않는다.
- 앱 종료·창 닫기·새로고침·renderer 충돌 뒤 생성 요청은 journal receipt로 재조회한다. 중간 단계 실패 시 만들어진 폴더/브랜치를 임의로 지우지 않는다. 준비하는 중 요청 글자와 Git 조회15초/생성120초 한도를 사용한다.

## 실패·재시도 계약 → verify

| 상황 | 처리·시험 |
|---|---|
| 결과를 모를 때 | pending/unknown receipt·경로·목록 다시 읽기. 폴더/branch/HEAD/commonDir 실조회 후 created/unknown. 생성 재실행 대신 같은 요청 대조 시험 |
| 다시 시도 | 같은 입력의 미확인 생성은 같은 request ID. 입력 변경은 새 요청이며 앞 결과 확인 안내. 이력 저장 실패는 후속 쓰기 차단 |
| 이중 입력 | UI lock·저장소 mutex·전역 요청 ID 충돌 거부. 다른 저장소의 receipt 저장도 동기 merge로 보존 |
| 취소·뒤로·닫기 | 미전송 입력 보존, 확인 취소는 Git 실행 없음. 이미 시작한 작업 결과는 재조회, 늦은 open은 일감 생성 없음 |
| 삭제 확인 후 변화 | 고정 HEAD/branch/path/commonDir 대조. 실제 HEAD 변경 e2e와 사용 revision 변이 |
| 읽기/쓰기 겹침 | 늦게 도착하는 옛 응답은 generation으로 버리고 쓰기 뒤 한 번 재조회. 부수 요청은 수동 새로 읽기·singleflight이며 안 보일 때 polling 없음 |
| 초기 값 | 처음 한 번 읽은 설정을 저장 작업에 재사용하지 않고 최신 앱 사용 경로/실제 Git 상태를 확인 |
| 실제 대조 | 가짜가 흉내 내지 않는 Git 상태 분기(거절/한도/별도 git-dir/빈 결과/부정확 상태)를 실제 임시 Git으로 대조. 실제 사용자 저장소·외부 hooks·NAS·실제 공급자는 실제 대조 안 함 |

## 코드와 시험

`src/shared/worktree-management.ts`, `src/main/worktree-management.ts`, `src/main/worktree-ipc.ts`, `src/renderer/WorktreePanel.tsx`, `src/renderer/worktree-panel.css`. 전용 strict probe는 `src/main/cwd-probe.ts`·`src/shared/cwd.ts`.
시험은 `tests/unit/worktree-management.test.ts`(실제 임시 Git30개), strict probe parser/실제 자체 자식 프로세스/프로세스 실패, `tests/e2e/worktrees.spec.ts`의 실제 Electron+임시 Git이다. Electron worktree IPC 접착부는 해당 e2e로 검증하며 Git 순서·파싱·journal은 node 시험으로 검증한다.

독립 HIGH 두 건을 수정했다. (1) 내부 async 사용 경로 검사 중 앱 상태 변화를 revision으로 막음. (2) 실제 cwd의 lsof escape를 불명 처리. 후자는 실제 Electron의 clean worktree를 newline/backslash 이름으로 옮기고 orphan 셸 cwd로 쓰는 시험2개에서 RED(정리 가능 오판)→GREEN을 확인했다. 정상 orphan 셸도 일감 목록 밖에서 used 보호를 확인했다.

UI/UX 준비 감사에서 찾은 nested 확인창 뒤 전역 단축키 HIGH도 이 정리 화면에 적용해 즉시 수정했다. App의 runCommand와 capture 단계가 aria-modal을 확인해 ⌘T·⌘W·undo/빠른 명령의 뒤 화면 변경을 막고, Escape/Tab 등 확인창 자체 키는 유지한다. 해당 확인창 e2e와 변이로 검증한다.

## 검증·UI/UX·GC

최종 결과는 완료 후 기입한다. 직접 본 캡처는 `test-results/worktrees-created.png`·`test-results/worktrees-small-light.png`. macOS/Electron·다크 일반 창·라이트320 CSS px/200%, 네이티브 입력/확인 취소·연결 일감·생성/정리 복구 확인. 하네스 U1(상태/통제/복구),A1(이름/키보드/리플로),A2(확인창). 보조 패널/toolbar 전체 정렬 개선은 승인된 최종 UI/UX에서 이어간다. 실제 VoiceOver/IME/Retina·사용자 환경 hooks·외부 writer 동시성 전체 보장은 미검증, 실제 참여자 테스트 없음.

## 단계 회고·GC

읽기 전용 진단 `/tmp/taskminal-39-gc.json`: 승격 후보 r89439e, 승격 후 재발 rd0536c, 병합 후보 없음, Electron 규칙 감사 toolable0. 정확한 회귀 변이와 실제 설치 도구/임시 프로그램 대조로 대응했다. 전역 학습 규칙의 생성·승격·병합은 자동 반영하지 않았다. Codex transcript 수집기는 미지원 형식이므로 token/훅 통계는 미측정이다.

| 항목 | 조치·근거 |
|---|---|
| 표시용 probe를 삭제 승인에 사용 | 실제 newline/backslash live cwd RED를 재현하고 strict 별도 parser/프로세스 실패 시험·실제 child probe로 수정. 모호한 값은 오판하지 않고 차단 |
| 비동기 내부 사용 경로 경쟁 | pending spawn·state revision과 최종 같은 turn 검사, 해당 guard 제거 변이 검출 |
| 확인창 뒤 단축키 | 최종 UI/UX 준비 감사의 HIGH를 정리 화면에 즉시 반영, ⌘T/⌘W 회귀 및 guard 제거 변이 검출 |
| Git의 숨긴 untracked 설정 | 실제 임시 Git으로 안전하지 않은 no-force remove를 확인한 뒤 Git 자식 설정도 all로 고정. ignored 포함 별도 preflight 유지 |
| 시험/도구 오류 | fixture userData 디렉터리 생성 누락, task명 기반 tablist label을 고정 문구로 가정한 선택자 수정. 변이 TSV regex 백슬래시를 --check에서 점검·수정 후 실행, 판정 불가를 검출로 세지 않음 |
| 모델·위임 | sol high가 고위험 Git 서비스·설치 lsof 검토와 strict probe, parent가 IPC/사용 경로/프로세스·UI 연결/실제 e2e·변이 검증. sol medium은 후속 UI/UX·브라우저 초안을 별도 임시 폴더에서 준비. 중복된38리뷰는 중단하고 파일을 분리. parent+worker 총토큰 미측정·절감률 주장 없음 |
| 추가 개선 | 실제 OS cwd/외부 writer의 최종 검사 뒤 경쟁은 남김. 강제 삭제·rm 보상 대신 미확인 결과를 표시하며 전역 판단 문구 추가보다 실제 가드/시험으로 옮김 |

핵심 변이8개(ignored·used·기본 등록·HEAD·생성 전 journal·revision·lsof escape·모달 키) 모두 검출·원복, `/tmp/taskminal-39-mutations.log` 67초. 처음 원문 점검 실패는 실행되지 않았으며 검출 수에 포함하지 않는다. 최종 전체 결과는 아래에 별도로 기록한다.

전체 검사 최초 `/tmp/taskminal-39-full.log`는 단위1,121 통과 뒤 e2e297통과/2실패·재시도도 실패로 종료1이었다. 새 모달 capture guard의 stopPropagation이 모달 내부 ⌥2·설정 키 수집까지 막은 실제 회귀다. capture 단계에서 앱 처리만 return하고 모달 자체 키 전달은 유지하도록 수정했다. 원격 전환·단축키 설정·정리 확인창3개를 함께 재검증해 통과(`/tmp/taskminal-39-modal-fix.log`)했고, 모달 보호 변이를 다시 검출·원복했다(`/tmp/taskminal-39-modal-mutation.log`,10초). 최종 전체는 별도로 다시 실행한다.

## 최종 전체 결과

`/tmp/taskminal-39-final-full.log` 종료0: typecheck·경계·단위1,121·e2e299 통과, 패키징 전용1 skip. e2e445초. 최초 회귀2건을 통과로 덮지 않고 위 로그에 보존했다.
