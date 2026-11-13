# 34단계 — 내장 브라우저·요소 전달

승인 계획: `~/.claude/plans/taskminal-orca-five-areas-2026-11-13.md`.

## 구현

- 일감의 작업 도구에서 브라우저 보조 pane을 연다. 포트 우클릭의 '앱 안에서 보기'로 주소를 넣어 연다. 기본 포트 클릭의 외부 열기는 유지한다.
- 주소·뒤로/앞으로·새로고침·중단·확대/축소·외부 열기·페이지 닫기·로드 실패 안내.
- main의 WebContentsView. 앱 preload 없음, nodeIntegration false, contextIsolation true, sandbox true, webSecurity true.
- http(s)만 허용하며 URL 자격증명을 거절한다. 탐색과 redirect 모두 검사한다. 팝업·다운로드·권한 요청을 차단한다.
- 일감별 영속 session partition으로 쿠키를 분리한다. 닫은 페이지는 조회·배치 주기가 다시 만들지 않는다.
- 앱 zoomFactor를 반영해 CSS 좌표를 네이티브 DIP로 바꾼다. 모달·설정·숨김·탭 전환 때 뷰를 숨긴다.
- 요소 선택은 사용자가 켠 뒤 20초 또는 Esc로 끝난다. 선택자·제한된 HTML·관련 스타일을 미리 보여 준다. 입력칸·비밀번호·스크립트와 임의 속성은 수집하지 않는다. 공통 비밀값 가림을 적용한다.
- 스크린샷과 요소 자료는 확인 후 대화 입력칸에 넣는다. 자동 전송하지 않으며 페이지 내용을 실행 지시로 취급하지 않는다.
- 브라우저는 일감당 하나의 보조 pane이다. 기존 터미널 분할 레이아웃의 새 kind를 추가하는 대신, 작업 도구가 보조 화면을 소유해 프로세스 집계·복원과 분리했다. 넓은 창에서는 대화/셸 옆, 작은 창에서는 본문 위를 사용한다.

## 검증

- `tests/e2e/workspace-tools.spec.ts`: 실제 로컬 HTTP 페이지 탐색·캡처·요소 전달, 원격 페이지의 window.taskminal/require 부재, file: 거절, 모달 위 가림 방지, 200% 좌표, 닫은 페이지 재생성 방지.
- fake 페이지는 외부 OAuth·인증서 오류·실제 사이트 렌더링을 대신하지 않는다. 실제 대조는 로컬 HTTP와 Electron WebContents에서만 수행했다.
- 스크린샷·전체 회귀·변이 결과는 통합 결과에 기록한다. 실제 외부 사이트 계정에 로그인하지 않았다.
- API 근거: https://www.electronjs.org/docs/latest/api/web-contents-view · https://www.electronjs.org/docs/latest/tutorial/security . Electron 45 로컬 타입도 확인했다.

## 수명·한계

- 앱 종료/창 닫기/renderer 충돌은 뷰와 WebContents·리스너를 해제한다. 새로고침에서는 먼저 뷰를 숨기고 신뢰 renderer가 배치를 요청할 때만 다시 보인다.
- 화면 전환은 숨김이며 '페이지 닫기'는 WebContents 해제다. 재진입은 살아 있는 페이지를 사용한다.
- 쿠키는 일감별 partition에 유지되지만 주소·웹 폼·캡처 초안은 앱 재시작 후 자동 복원하지 않는다. 민감 URL의 자동 저장을 피한 결정이다.
- 임의 팝업·다운로드·장치 권한·다중 브라우저 탭·원격 호스트 브라우저는 제공하지 않는다.
- 고급 브라우저 프로필 관리와 크로스 프레임 요소 선택, 실제 Retina·VoiceOver는 미검증이다.
