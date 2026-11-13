# 43단계 — OS별 앱과 다운로드

사용자 요청: “orca처럼 apple 실리콘 뿐만 아니라 다른 OS들도 다운 받을수 있도록 해줘”. 기존 자율 진행·GitHub/Pages 게시 지시를 이어 적용한다. 현재 기능 브랜치를 이어 쓰고 main에는 홈페이지 변경만 반영한다. 새 OS는 실제 네이티브 러너의 패키지 실행 검증에 성공한 뒤 제공한다.

## 계획

1. 런타임: macOS arm64/x64, Windows x64(PowerShell·ConPTY), Linux x64(로그인 셸) 구분. 셸 기본값·인자·지킴이/CLI 연결·자식 실행 경로를 OS에 맞게 고친다. Windows에서는 Unix 소켓 파일 검사/권한 작업을 적용하지 않는다. macOS 전용 부가 기능은 해당 OS에서만 실행하며 지원 상태를 정확히 알린다.
   - verify: 순수 플랫폼 분기 단위 시험 + 네이티브 패키지에서 임시 데이터로 셸 입력/출력·지킴이 재연결·앱 종료 확인. 기존 Mac 회귀 검사.
2. 패키징: 아키텍처에 맞는 node-pty, Intel Mac dmg/zip, Windows NSIS exe, Linux AppImage/deb. GitHub Actions 네이티브 OS별 빌드/스모크 검사 후 artifact 보관. macOS 서명/공증은 기존 로컬 키체인으로 한다. Windows 인증서 없는 빌드는 미서명임을 명시한다.
   - verify: 타 OS 네이티브 모듈 누출 없음, 실제 실행 스모크·파일 종류/manifest/해시 확인. Apple 두 아키텍처 서명/공증 확인. 새 버전은 0.1.2로 하여 이미 공증된 0.1.1을 덮어쓰지 않는다.
3. 홈페이지: 한국어/영어 운영체제별 다운로드 목록, OS 자동 추천, 다른 OS 선택, 모바일에서도 목록 제공. 탐지 불명은 칩을 임의로 정하지 않고 Mac 두 선택지를 제공한다. 최신 공개 릴리스에 실제 있는 자산만 직접 다운로드 링크로 제공한다.
   - verify: OS·칩·언어별 선택 시험, 네트워크 실패/없는 자산/늦은 응답에서 잘못된 파일 연결 없음, 데스크톱·모바일 실제 화면과 키보드 확인.
4. 통합: 관련 변이 → typecheck/경계/단위/e2e → diff 리뷰. 버전별 draft를 만들어 검증된 산출물만 업로드, 해시와 자산 확인 뒤 공개. 홈페이지 변경만 main에 반영하여 Pages 해당 실행과 공개 응답을 확인한다. 단계 문서·개발 문서·GC 회고·커밋·기능 브랜치 push.

## 실패·재시도·수명

- 결과를 모를 때: CI run id, Apple submission id, GitHub release id와 source SHA를 기록하고 상태를 조회한다. 같은 버전에 새 제출/릴리스를 중복 생성하지 않는다.
- 다시 시도: 실패한 OS만 수정·재실행하고 통과하지 않은 플랫폼은 다운로드가 준비 중임을 표시한다. 기존 공개 자산은 삭제/교체하지 않는다.
- 읽기와 쓰기가 겹칠 때: 게시 성공 후 기존 자산 조회 결과는 무효화하고 다시 읽는다. 페이지의 조회 중에는 ‘다운로드 확인 중’을 표시하고 새 결과가 오기 전 다른 파일로 연결하지 않는다. 시험: 지연된 API 응답 전후 수동 OS 선택 유지.
- 중간 단계 실패: 빌드→실행 검증→공증→업로드→공개마다 완료 결과를 기록한다. 공증 실패는 기존 submission 조회부터, 업로드 실패는 같은 draft의 기존 자산 대조부터 다시 시도한다. 시험: 패키지 실행 실패 시 공개 단계에 도달하지 못하는 CI 의존성 확인.
- 붙는 중 표시: 지킴이는 기존 starting/reconnecting 상태 글자와 5초 연결 시간 한도를 유지한다. 홈페이지 API 조회는 10초 뒤 종료하고 릴리스 페이지 링크로 복구한다. 시험: 응답 없는 API에서도 상태가 완료되고 복구 링크 노출.
- 이중 입력: 홈페이지는 읽기 전용 자산 조회 한 번을 공유하고, 자동 탐지가 늦게 끝나도 사용자가 선택한 OS를 바꾸지 않는다.
- 취소·뒤로: 로컬 검증은 임시 데이터에 한정, 실제 앱/셸/계정 데이터는 건드리지 않는다. 페이지 이동은 서버에 자원을 만들지 않는다. 이미 만든 draft/공증 제출을 몰래 삭제하지 않는다.
- 홈페이지 저장 충돌: main 최신 blob SHA로 조건부 저장, 충돌 시 다시 읽어 homepage 변경만 적용. feature 전체 병합은 하지 않는다.
- 앱 종료/창 닫기/새로고침/렌더러 충돌은 기존 셸 지킴이 수명을 보존한다. Windows 파일 시스템 감시로 named pipe를 소켓 파일로 착각해 셸을 끝내지 않는다.
- 실제 OS 설치/실제 Claude·Codex 계정/VoiceOver·Retina는 별도 실환경 검증으로 구분한다. 이 계획은 실제 /Applications 설치나 계정 메시지 전송을 포함하지 않는다.

## 분담

시간과 독립 검토 목적: 런타임 호환성 작업 1명, 패키징/CI 1명, 부모는 홈페이지·통합·게시. 파일 경계를 분리한다. 총 토큰/비용 절감은 미측정이며 주장하지 않는다.

공식 근거: https://www.electron.build/v26/docs/features/multi-platform-build/ (네이티브 모듈은 대상 OS 러너), https://github.com/microsoft/node-pty (ConPTY 및 OS 지원).

## 진행 기록

- 홈페이지 단위 7개 통과. Intel→ARM 오추천·외부 URL 허용·없는 자산 연결 변이 3개 모두 검출(`/tmp/taskminal-platform-site-mutations.log`). 실제 API에 아직 공개 릴리스가 없어 실패 상태가 표시됨을 확인했다. 준비된 전체 목록 화면은 가짜 릴리스 데이터로만 확인했으며 공개/다운로드 완료로 세지 않는다.
- UI/UX: 데스크톱 5열, 모바일 390px 1열·가로 넘침 없음. 한국어/영어 준비 중·조회 실패·모바일 안내 확인. Orca screenshot scale=2의 타일 중복 캡처는 scale=1로 다시 확인했다. 최종 모바일 증거: `/var/folders/ly/4sm0t3qs4pgg3mpqcrrh7c580000gn/T/orca-browser-screenshots/a587cc08-2ee2-430d-b108-2437edab01cd-screenshot.png`. 실제 참여자/스크린리더 사용성 시험은 미수행.
- 빌드 검토에서 node-pty `binding.gyp`의 spawn-helper가 macOS 전용임을 확인하고 Linux는 해당 파일을 요구하지 않도록 수정·회귀 시험 추가. 네이티브 파일 구조는 설치된 의존성의 실제 파일을 기준으로 검사한다.
- GC 진단 `/tmp/taskminal-platform-gc.json`: 전역 규칙 변경·승격은 하지 않음. 최종 회고에서 후보/재발과 실제 도구화 조치를 함께 정리한다. 부모+worker 총 토큰·금액은 도구가 제공하지 않아 미측정.
- 최종 소스 타입 검사·단위 1,174개 통과(`/tmp/taskminal-platform-typecheck-final.log`, `/tmp/taskminal-platform-unit-final.log`). macOS 회귀 e2e 진행 중(`/tmp/taskminal-platform-full-check.log`); 시작 후 보강한 Ctrl 매핑은 Mac의 meta 동작을 그대로 유지하고 별도 단위·네이티브 OS 스모크로 검증한다.
- 네이티브 CI 검증을 시작하기 위해 후보 소스를 기능 브랜치에 커밋·push한다. 이 시점은 출시 완료가 아니며, 실제 타 OS 실행·서명/공증·공개 릴리스/Pages 확인은 뒤의 결과 절에 기록한다.
- Windows 첫 지원의 명시적 제한: 포트 자동 감지 없음, 실행 중 폴더의 엄격한 확인이 필요한 worktree 정리는 안전하게 거절, 추가 계정의 TUI 전환은 미지원. 기본 터미널·대화·파일·OS 기본 Ctrl 단축키는 검증 대상이다. Linux AppImage/deb의 실제 설치 UX와 실제 계정 대화는 별도 실환경 검증이다.
- 추가 사용자 요청: “릴리즈노트도 잘 꾸며줘 Docs도 페이지에 있으면 좋겠어”, “GitHub ReadMe도 잘 꾸며주고”. 한국어·영어 Docs와 홈페이지 연결, README, `docs/releases/v0.1.2.md`를 포함한다. main 게시 범위는 홈페이지·Docs·README로 확장하고 앱 전체 병합은 하지 않는다.
- CI1(`43520068857`, `eb50598`): Mac arm64 통과. Windows 파일 URL과 실제 경로 비교 차이를 실제 실행에서 발견하고 `src/main/page-origin.ts`로 안전한 파일 URL 변환·일치 확인을 추출했다. 회귀8개와 정확한 옛 비교 구조 변이 검출. Linux 파일명의 builder 아키텍처 별칭도 실제 빌드 결과를 보고 x64로 고정했다.
- CI2(`43521335446`, `010631e`): Mac arm64 통과. Windows 한글 셸·Ctrl 팔레트·CLI·가짜 Codex·reload, Linux 한글 셸·Ctrl 팔레트·CLI·reload 통과. 둘 다 `Playwright.close()`가 main 정상 종료/실행 래퍼 종료 중 어디서 기다리는지 불명확하여 실제 정상 `app.quit`+main PID 소멸/exit0+수명 로그로 분리 검증한다. 아직 실제 앱 종료 결함이나 도구 결함으로 단정하지 않는다.
- 버전 증가로 고정된 옛 업데이트 피드/앱 정보 시험이 실패해 현재 package 버전·다음 버전을 쓰도록 수정, 관련 e2e23개 통과. 320px 시험은 창 크기 변경 직후 두 도구 메뉴가 잠시 함께 존재하는 상태를 피하도록 의도한 compact navigation으로 범위를 한정했다.
- Mac 재실행 `/tmp/taskminal-platform-final-full.log`: 단위1,182 · e2e315 통과, 메뉴 단축키 표시1개 실패. Mac 기존 accelerator 문자열을 보존하도록 수정 후 keys e2e13개 통과. 최종 전체는 다시 확인한다. 앞 실행의 줄 번호가 편집으로 이동하면서 하네스 재시도가 실제 실패6개 중1개만 실행한 사례는 전체 통과로 세지 않는다.
- 변이: 홈페이지3·런타임7·패키징3·파일URL 옛구조1 모두 검출. GC 도구화: OS 네이티브 구조 검사·스모크·파일 URL 회귀를 실제 구현했다. `r89439e` 승격 후보는 이미 변이 도구로 검사하므로 자동 승격 보류, `rd0536c` 재발 진단은 설치된 소스·실제 러너 대조로 다룬다. 전역 엔트리는 사용자 선택 없이 변경하지 않는다.
- 이전 후보의 Mac 서명/공증 빌드는 별도 디렉터리에 보존하고 중단했으며 공개하지 않는다. 0.1.1 및 이전 후보의 승인 이력은 새 수정본의 공증 승인으로 대신하지 않는다. 실행 중인 사용자 앱과 원래 dist/mac-arm64는 보존했다.
- CI3(`43523016840`, `0c6fdea`): Windows·Linux에서 정상 `app.quit`의 실제 main exit0·PID 소멸, 재실행 후 같은 guardian 재연결이 모두 확인됐다. 실패는 종료 뒤 `ElectronApplication.process()`가 이미 삭제된 Playwright 내부 객체를 읽던 진단 코드에서 발생했다. 시작할 때 ChildProcess를 보관하도록 수정했다. 기존 Mac arm64 0.1.0 패키지/임시 데이터로 수정된 검사 하네스의 전체 흐름1개 통과(`/tmp/taskminal-platform-smoke-arm-harness.log`); 이는 새 버전 검증으로 세지 않는다.
- 최종 앱 소스의 전체 검사 `/tmp/taskminal-platform-clean-full.log` 종료0: 타입·경계·단위1,182·e2e316 통과(패키지 전용2 skip). 이후 변경은 스모크 진단의 종료 후 객체 접근 수정이며 앱 코드는 바꾸지 않았다. OS별 최종 패키지 검사는 CI4에서 다시 확인한다.
