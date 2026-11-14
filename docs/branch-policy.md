# 브랜치와 승인 운영

2026-11-14 사용자 지시: main에는 사용자가 직접 한 작업 또는 사용자가 승인한 PR만 반영한다. 이 규칙은 과거 포괄적 자율 진행 지시보다 우선한다.

| 용도 | 브랜치와 처리 |
|---|---|
| 승인된 통합 코드 | main. 에이전트의 main 직접 push·자동 병합·관리자 우회 금지 |
| 독립 기능 | 최신 origin/main에서 feat/<주제>, PR base main |
| 독립 버그 수정 | 최신 origin/main에서 fix/<주제>, PR base main |
| 운영·문서 | 최신 origin/main에서 chore/<주제>, PR base main |
| 미병합 기능에 의존 | 해당 기능 브랜치에서 분기하고 PR base를 그 브랜치로 지정. 선행 PR과 합칠 순서를 명시 |
| 기존 누적 기능 | stage-44-48-orca-workflow는 보존. 24개 기존 커밋을 임의 재작성하거나 통째로 main에 병합하지 않음 |

PR에는 문제·결과 동작·검증 결과·남은 한계·의존성을 적는다. 에이전트는 PR 제출 후 사용자 검토를 기다리며 사용자 명의 승인 리뷰를 대신 작성하지 않는다. 검토 이후 변경이 더해지면 현재 diff에 대해 다시 승인을 받는다. 공개 릴리스·태그·공증·배포는 별도 명시적 요청이 필요하며 현재는 보류한다.

## GitHub 설정과 한계

main 보호에 승인1개, Code Owner 리뷰, 새 커밋 시 이전 승인 해제, 미해결 대화 해결 필수, force push·삭제 금지를 설정했다. CODEOWNERS는 모든 파일에 @petercorders를 지정한다. 이 파일은 main에 병합된 뒤 코드 소유자 리뷰 요구에 적용된다. PR용 CI는 이 변경으로 신설하지 않았으며 필수 상태 검사도 아직 지정하지 않았다.

현재 개인 저장소의 유일한 collaborator/관리자는 petercorders다. 관리자 예외는 본인이 직접 작업하거나 직접 작성한 PR을 검토·병합할 수 있도록 유지한다. 본인이 작성한 PR에 본인이 승인 리뷰를 남길 수는 없으므로 이 경우에는 본인이 검토 후 관리자 예외로 병합한다.

에이전트의 gh도 동일한 petercorders 계정으로 인증되어 있다. GitHub는 같은 계정의 사람과 에이전트를 구별할 수 없으므로 위 서버 설정만으로 에이전트 권한까지 분리됐다고 간주하면 안 된다. 에이전트는 AGENTS.md·CLAUDE.md의 승인 경계를 지킨다. 권한 자체의 분리가 필요하면 별도 bot 계정/GitHub App을 사용하고 관리자 권한을 주지 않아야 한다.

공식 근거: [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

## 이번 확인

- 변경 전 main 보호 API는 404, rulesets는 빈 목록이었다.
- 개인 저장소의 사용자별 bypass 설정은 GitHub API가 422로 거절해 변경되지 않았다. 관리자 예외를 유지한 보호 설정은 적용 후 GET으로 확인했다.
- 문서·승인 설정만 변경했다. 앱 코드·의존성 변경이 없어 전체 앱 시험과 변이 시험은 실행하지 않았다. diff 공백 검사·main 대비 변경 파일·보호 API 설정·CODEOWNERS 구문을 확인한다.
- 기존 기능 브랜치와 공개 릴리스는 main에 반영하지 않는다. 이 운영 규칙 PR도 사용자 승인 전에는 병합하지 않는다.
