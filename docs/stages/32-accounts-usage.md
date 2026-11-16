# 32단계 — 사용량·계정

승인 계획: `~/.claude/plans/taskminal-orca-five-areas-2026-11-13.md`. 31~35단계를 같은 브랜치에서 통합한다.

## 구현

- 작업 도구와 명령 팔레트에서 사용량·계정 화면에 접근한다. 좁은 화면은 작업 도구 선택 메뉴를 사용한다.
- 기본 Claude·Codex 계정, 추가 계정 만들기·로그인·새 대화 기본 선택. 사용 중인 대화는 pane별 계정 바인딩을 유지한다.
- 추가 계정은 userData의 accounts 아래 공급자별 UUID 폴더. 토큰을 복사하지 않고 설치 CLI의 로그인 절차를 사용한다. 이름·선택·바인딩만 원자적으로 0600 파일에 저장한다.
- Codex는 CODEX_HOME을 격리하고 file 인증 저장 정책을 조회·로그인·대화·TUI에 맞춘다. Claude 추가 계정은 CLAUDE_CONFIG_DIR와 Claude.ai 로그인을 사용한다. Console 로그인 격리는 제공하지 않는다.
- 추가 계정의 API 키·대체 공급자·클라우드 인증 환경은 직접 실행에서 제거한다. TUI는 로그인 셸에서 새로 생긴 키까지 제거하도록 env -i와 명시적 환경 목록을 사용한다.
- 대화 나누기에서 원 pane의 계정을 복사한다. TUI 전환·로그인 띠는 원 계정의 명령 환경을 사용한다. 계정 확인 실패 시 대화를 닫지 않는다.
- accounts.json 손상은 빈 계정으로 바꾸지 않는다. 원본을 보존하고 재개를 차단해 다른 인증 주체로 이어지는 것을 막는다. 초기 파일 없음은 정상이다.
- Codex app-server account/read → account/rateLimits/read. 제공되는 버킷별 실제 사용률·초기화 시각을 표시한다. 정상 0%, 미로그인, 미지원, CLI 없음, 조회 실패를 구별한다.
- Claude는 auth status --json으로 상태를 읽는다. 공식 비대화형 플랜 한도 조회는 확인되지 않아 수치를 만들지 않고 미지원으로 표시한다.
- 한 번에 한 조회, 15초 제한, 화면의 30초 갱신·창 복귀 갱신. 늦은 계정 응답은 세대로 버린다. 로그인은 5분 제한·중단·출력 안내를 제공하며 중복 입력을 막는다.

## 검증과 근거

- `tests/unit/accounts.test.ts`: 0%·누락·잘못된 수치·여러 버킷·Unix 초 변환.
- `tests/unit/account-isolation.test.ts`: 직접 실행과 실제 zsh TUI의 인증 환경 격리, 바인딩 유지·분기·재시작, 인증 저장 설정, 손상 fail-closed.
- `tests/unit/account-protocol.test.ts`: 실제 자식 프로세스인 가짜 Codex의 JSON-RPC 조회, 중복 요청·로그인 한 번, 미로그인 구분. 실제 계정이나 인증값을 읽지 않는다.
- `tests/e2e/workspace-tools.spec.ts`: 계정 추가·선택·0%와 미지원 안내를 UI에서 구별.
- 공급자 조사: 설치 Codex CLI와 Claude 2.1.323 도움말. 공식 문서 https://learn.chatgpt.com/docs/app-server · https://learn.chatgpt.com/docs/auth · https://code.claude.com/docs/en/authentication .
- 실제 로그인 완료, 실제 공급자 플랜 숫자와의 대조는 하지 않았다. 가짜 프로그램이 흉내 내지 못하는 OAuth·키체인·요금제 차이는 실제 환경 미검증이다.

## 수명·남은 한계

- 앱 종료에서 조회·로그인 자식을 정리한다. 화면 닫기는 실행 중 로그인을 성공/취소로 오인하지 않으며 다시 열어 상태를 확인한다.
- 새로고침·충돌 후 이름·선택·바인딩은 복원하고 사용량은 재조회한다. 토큰·로그인 출력은 renderer 상태 파일에 저장하지 않는다.
- 계정 삭제·자동 교체·한도 예측은 범위 밖이다. 저장 기록이 손상된 경우 자동 복구 대신 원본을 보존해 명시적으로 복구해야 한다.
- 기본 계정 로그인은 기존 CLI에서 진행한다. 추가 계정에서만 앱이 로그인 프로세스를 띄운다.
- 실제 계정·Retina·IME·VoiceOver는 미검증. 통합 전체 검사 결과는 개발 진행 문서의 31~35단계 항목을 따른다.
