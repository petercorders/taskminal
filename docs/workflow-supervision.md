# 실행 중 협업과 감독

50단계 기능 브랜치에서는 **작업 흐름**의 실행 기록에서 작업을 추가하고 worker별 메시지·질문·답변을 남길 수 있다. 기존 완료 결과는 유지하며 추가 작업은 의존 단계가 끝난 뒤 시작한다. 동시에 같은 일감의 다른 실행을 다시 열 수 없다.

질문은 실행·단계·pane·시도 번호에 연결된다. 답변이 없으면 해당 단계의 완료와 후속 단계 진행을 보류한다. 공급자의 추론 자체를 일시 정지하는 기능은 아니며 도구 허락·공급자 질문은 기존 대화에서 처리한다. 중단·재시도 후 이전 worker에 대한 늦은 답변은 거절한다. 메시지와 답변은 후속 worker의 프롬프트에 신뢰할 수 없는 참고 내용으로 전달된다. 실행 중인 공급자에게 자동으로 추가 메시지를 주입하지 않는다.

템플릿·추가 작업마다 선택적으로 모델과 추론 강도(low/medium/high)를 지정한다. 비우면 기존 공급자 기본값을 사용한다. 선택값은 해당 실행 인자로 전달하고 전역 계정 설정을 바꾸지 않는다. 설치된 CLI·계정이 지원하는 모델을 지정해야 한다. 실제 공급자 계정에서의 지원 여부는 별도 확인 대상이다.

## 로컬 CLI

실행 중 앱과 연결된 `taskminal` CLI를 사용한다. `view` 결과에서 정확한 실행·단계·pane·attempt를 확인한다.

```sh
taskminal workflow view --json
taskminal workflow append RUN_ID '{"id":"review","name":"검토","agent":"codex","prompt":"변경을 검토해 주세요","after":["implement"]}' --json
taskminal workflow message RUN_ID '{"id":"question-1","stepId":"implement","paneId":"PANE_ID","attempt":1,"kind":"question","text":"이 방향으로 계속할까요?"}' --json
taskminal workflow answer RUN_ID question-1 '계속 진행' --json
```

응답이 유실되면 같은 단계·메시지 ID와 같은 내용으로 재전송한다. ID를 다른 내용으로 재사용하면 거절한다. 모델 지정 예시는 단계 JSON에 `"model":"지원하는-모델","effort":"high"`를 추가한다. 이 CLI는 로컬 앱 소켓의 신뢰 경계를 사용하며 원격 익명 감독 API가 아니다.

## 코드 편집

파일 탐색의 **편집**에서 CodeMirror 기반 구문 강조·다중 커서·찾기/바꾸기·줄 이동을 제공한다. 기존 원문 CAS 저장과 충돌 시 초안 보존을 유지한다. 파일별 초안은 메모리에 유지하고 undo 모델은 최근 8개 파일까지 보관한다. 앱 종료 뒤 미저장 초안 복원이나 전체 언어 서버(LSP)는 포함되지 않는다.
