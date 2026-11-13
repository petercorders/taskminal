# 31단계 — 전체 작업 보기

기준 main `c6ed6dd`, 승인 계획 `~/.claude/plans/taskminal-orca-five-areas-2026-11-13.md`.
전체 구현은 31~35단계 작업 브랜치에서 통합한다. 이 문서는 31단계 범위와 수행한 검증만 기록한다.

## 구현

- `src/renderer/overview-model.ts`: 사이드바 `flowSections`를 재사용한 상태별 카드 집계. 보관 일감·어느 탭에도 속하지 않는 pane 제외.
- `src/renderer/Overview.tsx`: 전체 보기, 상태 필터, 일감·묶음·브랜치·에이전트 검색, 결과 개수, 검색 없음과 빈 일감 안내.
- 일감 카드: 이름·묶음·브랜치·폴더, 안 읽음, 최근 활동과 가린 활동 한 줄, 화면별 상태·정확한 탭/pane 이동 단추.
- 카드 기본 이동은 확인 필요 → 실행 중 → 활성 탭의 pane → 첫 화면 순서. 화면별 단추는 지정 pane만 연다.
- 조작 직전에 현재 상태에서 대상 일감·탭·pane을 다시 검사한다. 대상이 사라졌으면 다른 화면으로 대체하지 않고 안내한다.
- 키보드: 초기 검색 포커스, native input/select/button, Escape 닫기. 필터 초기화 후 검색 포커스.
- 전체 보기 표시와 기존 task-view 마운트 유지, 사이드바·명령 팔레트 진입, 공통 CSS를 App에 연결했다.

## 검증

- 단위 `tests/unit/overview.test.ts` 6개: 구현 전 모듈 없음 실패 확인 후 6개 통과.
- `tsc --noEmit -p tsconfig.web.json` 통과.
- e2e `tests/e2e/overview.spec.ts` 3개 통과: 상태/검색과 정확한 탭 이동, 전체 보기 전환 중 셸 작업 유지, 최소 창·200% 확대 키보드 이동. 최초 통합 실행에서 광범위한 data-tab-id/data-task-name 선택자가 탭/사이드바까지 중복 선택해 2건 실패했으며, 각 task-view/tab-view 범위로 좁힌 후 3개 통과했다.
- 순수 로직 변이 3개 확인: 보관 제외 제거, 닫힌 대상 검사 제거, 확인 필요 우선순위 제거를 모두 단위 시험이 잡았다. mutation-check batch 종료 0, 9초, 소스 모두 복원. 목록 `/tmp/taskminal-overview-mutations.tsv`.
- 스크린샷 `test-results/overview-wide.png`와 `test-results/overview-small-zoom.png` 직접 열람. 최초 작은 화면의 사이드바/도구 줄 압박을 접이식 사이드바와 한 줄 도구 메뉴로 수정했다. 확대 직후 CSS 폭 변경을 기다리고 보이는 진입점으로 이동하는 시험도 확인했다.
- 전체 회귀·공통 레이아웃·미검증은 `docs/stages/31-35-verification.md`에 기록한다.

## 수명·오류

- 전체 보기는 프로세스를 소유하지 않는다. App가 기존 터미널·대화 마운트를 유지해야 한다.
- 앱 종료·창 닫기·렌더러 새로 고침·충돌 시 전체 보기의 로컬 검색/필터 상태는 사라지며 별도 프로세스·구독은 남지 않는다. 기존 세션 수명은 App 정책을 따른다.
- 검색 결과 없음은 서버 실패와 다르다. 화면은 이미 읽은 상태를 사용하며 별도 서버 요청·폴링을 만들지 않는다.
- 색상만으로 상태를 표현하지 않고 기존 ActivityIcon과 상태 글자를 함께 보인다.
- Retina·실제 IME·VoiceOver·실제 사용자 과업 측정은 이 단계에서 미검증.
