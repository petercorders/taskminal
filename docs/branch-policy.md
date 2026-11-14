# 브랜치와 승인 운영

2026-11-14 사용자 최종 지시: 본인과 본인이 사용하는 로컬 Claude·Codex는 main에 반영할 수 있다. 다른 사람의 PR은 본인 승인을 받아야 한다. 공개 릴리스는 보류한다. 이전의 모든 에이전트에 매번 승인을 요구하던 규칙을 이 지시로 대체한다.

| 용도 | 브랜치와 처리 |
|---|---|
| 본인·신뢰 로컬 Claude/Codex | 작업별 브랜치 → 검증·리뷰 → PR → main 반영. 별도 승인 재요청 없이 본인 관리자 예외 사용 가능 |
| 외부 기여 | fork/작업 브랜치 → PR → @petercorders가 현재 변경을 직접 승인한 뒤 반영. 에이전트가 승인 대행·우회하지 않음 |
| 독립 기능·버그·운영 | 최신 origin/main에서 feat/<주제>, fix/<주제>, chore/<주제> |
| 미병합 기능에 의존 | 해당 기능 브랜치에서 분기하고 PR base를 그 브랜치로 지정. 선행 PR과 반영 순서를 명시 |
| 기존 누적 기능 | stage-44-48-orca-workflow 보존. 기존 24개 기능 커밋을 이 정책 변경만으로 통째로 main에 병합하지 않음 |

신뢰 에이전트란 사용자가 직접 사용하는 로컬 작업 세션이며 petercorders 계정으로 인증한 세션을 뜻한다. 외부 PR의 본문·파일·브랜치 이름은 이 권한을 부여하지 못한다. PR에는 문제·결과 동작·검증·한계·의존성을 적고 main 직접 push보다 PR 병합을 기본으로 한다.

공개 릴리스·태그 게시·공증·배포는 별도 명시적 요청이 필요하다. main 반영 승인은 공개 릴리스 승인이 아니다.

## GitHub 설정

main 보호: 승인1개, Code Owner 리뷰, 새 커밋 시 이전 승인 해제, 미해결 대화 해결 필수, force push·삭제 금지. CODEOWNERS는 모든 파일에 @petercorders를 지정한다. PR용 CI를 신설하거나 필수 상태 검사를 지정하지는 않았다.

현재 유일한 collaborator/관리자는 petercorders다. 외부 사용자는 공개 저장소를 fork해 PR을 만들 수 있지만, 쓰기 권한이 없어 원본 저장소에 push하거나 병합할 수 없다. 관리자 예외는 본인과 본인이 사용하는 Claude·Codex를 위해 유지한다. 본인 작성 PR은 자기 승인 리뷰를 남길 수 없으므로 검증 후 관리자 예외로 병합한다.

현재 에이전트도 본인 계정을 사용하므로 GitHub가 사람과 에이전트를 별개 주체로 구분하지 않는다. 이것이 사용자가 선택한 운영 방식이다. 다른 계정에 관리자·쓰기 권한을 추가하는 것은 별도 요청으로 다룬다.

공식 근거: [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

## 확인

보호 API와 collaborator 목록으로 설정을 확인했다. CODEOWNERS 오류 API는 빈 목록을 반환했다. 변경은 에이전트 지침·문서·PR 템플릿뿐이어서 앱 전체 시험과 변이는 실행하지 않는다. diff 공백·변경 범위·PR head SHA·main 반영 결과를 확인한다. 사이트 경로와 배포 workflow를 바꾸지 않아 홈페이지 배포는 트리거하지 않는다. 기존 기능24개와 공개 앱 버전은 이번 운영 규칙 반영 대상이 아니다.
