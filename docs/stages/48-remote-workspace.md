# 48 — 서버가 소유하는 원격 작업 공간

승인·수명 계약: `docs/ideas/orca-next-five-v2.md`. 사용 방법·제한은 `docs/remote-workspaces.md`.

서버 entry를 별도 bundle로 만들고 포함 Electron의 Node 모드에서 실행한다. loopback bind·0600 bearer token·Origin 거절·고정 RPC allowlist·요청/응답 한도·별도 데이터 디렉터리 잠금·canonical root/cwd 검사를 적용했다. 데스크톱은 메모리 토큰과 좁은 preload API만 사용하며 HTTPS 또는 SSH loopback 주소에 연결한다. 서버 응답은 메서드별 구조를 검증한 뒤 renderer로 보낸다.

파일 탐색/UTF-8 원문 편집·서명 충돌 저장, Git 상태/diff, 실제 PTY 출력·줄 입력, 기존 ChatManager의 구조화된 Claude/Codex 허락·질문·중단을 연결했다. 연결 해제·패널 닫기·클라이언트 앱 종료는 서버 프로세스를 끝내지 않는다. 생성·write·send·save 요청은 durable pending fence와 내용 hash로 중복 실행을 막는다. 불명 요청은 자동 replay하지 않으며 사용자 확인 후 새 ID만 준비한다. 원격 저장 원문을 receipt에 기록하지 않는다.

## 리뷰·검증

독립 서버 리뷰의 HIGH3건을 수정했다: 서비스 load 전 독점 잠금, queue 대기 후 cwd 재확인(에이전트 CLI 탐색 뒤 spawn 직전 동기 검사 포함), 종료 PTY의 PID 핸들 해제/출력 보존. UI/API 리뷰의 MEDIUM 응답 형식 검증을 보강했다. 잘못된 질문/허락 구조도 상태에 넣지 않는다. 실제 640×480/200% 점검에서 기존 숨겨진 탭 단추가 4px 가로 overflow를 만들던 문제를 측정해 가려진 pane의 overflow를 clip했다.

단위는 잘못된 원격 응답·TLS/redirect 표면·queue 중 symlink 교체·종료 PID 재사용을 검증한다. 실제 별도 서버 프로세스를 임시 폴더에서 띄운 e2e는 인증/Origin 거절, 경로 탈출, 실제 CAS 충돌/저장, 같은 ID 중복, 중복 서버 기동 거절/저널 보존, Git 상태, 클라이언트 연결 해제 후 같은 세션과 대화 이어받기를 검증한다. native 패널에서 파일 충돌 복구·실제 셸·응답 유실 재전송·앱 종료/재실행·Claude 허락·Codex 대화를 확인한다. 실제 계정·실제 원격 호스트는 사용하지 않는다.

핵심 변이3개(queued save 경계 제거·종료 PID 해제 제거·응답 schema 검사 제거)는 원본 타입 검사 통과 후 모두 시험 실패로 검출했다(`/tmp/taskminal-48-mutations.log`). 최초 변이 시도는 진단 코드의 NodeList 타입 오류 때문에 원본 compile에서 보류됐으며, Array.from으로 고친 뒤 다시 실행했다. 이를 검출 성공으로 세지 않았다. 전체 고정 tree 결과는 아래 완료 기록에 추가한다.

## GC

전역 상태는 읽기 전용 진단만 하고 자동 승격하지 않는다. 발견한 실제 결함은 문장 규칙 대신 경합·PID·응답 유실·반응형 회귀로 도구화했다. 원격 초기 시험의 잘못된 종료 이벤트 이름, 재시작 전 locator 재사용, 비동기 대화 생성 전에 입력한 시험은 실제 계약에 맞춰 고쳤다. 셸 echo를 실행 완료 증거로 삼던 시험도 실제 파일이 생긴 결과로 바꿨다.

읽기 전용 진단 `/tmp/taskminal-48-gc.json`: eden72·survivor28·cold12·promoted6, 승격 후보r89439e1개·병합0·규칙 감사17개. 해당 후보는 이번 정확한 변이로 도구화했으며 전역 규칙 승격은 필요하지 않아 적용하지 않았다. 기존 rd0536c 승격 후 재발11회는 이전 기록이며 이번 단계에서 reinforce하지 않았다. 개발 launcher로 실제 서버를 띄웠고 Mac/Windows/Linux 패키지 정적 검사에 server entry/launcher 누락 검사를 추가했다. 실제 새 설치 파일 생성·서명·공증은 수행하지 않았다.

부모가 서버/인증/수명/저장 통합을 구현했고 기본 모델 worker를 독립 보안·UI 리뷰에 사용했다. 한 차례 서버 경계 검토가 다른 UI 검증과 독립적이라 추가 읽기 전용 worker를 잠깐 사용했으며 이후 종료했다. 총토큰·비용·다른 모델 대비 절감은 미측정이다.

## 최종 완료

고정 tree `fe62045e30d5cb4d5a7504473239b8a964d156eb`를 별도 복사본에서 전체 검사했다(`/tmp/taskminal-48-full.log`). 타입·경계·단위1,206·e2e341 통과, 패키지 전용2 skip, script 종료0이다. 최초 실패·자동 재실행 없이 통과했다. 47단계에서 정정한 exact preload API/sandbox·지킴이 정리 시험도 포함했다. 관련 native 원격2개는 실제 개발 launcher로 서버를 띄워 완료했으며 부모가 wide·small·small-actions를 직접 열어 확인했다. 스크린샷은 임시 fixture만 사용한다. 최종 UI/UX·GC는 `docs/stages/44-48-uiux-gc.md`, 실제 서버 사용·제한은 `docs/remote-workspaces.md`다.

완료 기록 등 문서만 검사 뒤 추가했으며 앱 소스는 고정 tree와 같다. 공개0.1.2·main·설치된 사용자 앱·실제 계정/호스트는 변경하지 않았다.
