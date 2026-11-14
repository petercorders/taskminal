# 46 — 일감·탭 범위 브라우저 CLI

승인 범위는 `docs/ideas/orca-next-five-v2.md`. `taskminal browser tabs/navigate/snapshot/click/fill/screenshot`을 추가했다. 다른 일감이나 선택하지 않은 탭을 조용히 조작하지 않으며, snapshot의 nonce·실제 DOM 노드·탐색 세대로 참조를 제한한다. 새 snapshot, 페이지 이동, 탭 닫기·전환 후 옛 참조를 거절한다. `--expect-url`로 동작 전 주소를 확인할 수 있다. 실행 응답을 잃으면 결과 확인 후 새 snapshot을 받도록 안내한다.

웹 컨텐츠는 기존 격리 세션에서 실행하며 앱 API를 제공하지 않는다. snapshot은 입력값과 입력이 중첩된 label을 제거한다. 스크린샷은 iframe과 closed/open shadow root까지 CDP로 찾고 해당 컨텐츠·입력 노드의 inline style을 임시로 가린다. 페이지 스크립트를 잠깐 정지하고 fresh surface를 캡처한 뒤 style·스크립트 상태를 복구한다. debugger가 이미 사용 중이면 캡처를 거절한다. 일반 본문에 보이는 민감한 글자까지 자동 판별하는 기능은 아니다. 앱 기록 폴더에 0600 PNG를 최대20개 보관한다.

독립 리뷰에서 옛 최상위 CSS 마스크의 iframe/shadow/inline important 누락과 원본 label을 통한 입력값 재수집을 찾아 실제 PNG 동등 비교·중첩 label 회귀로 수정했다. 첫 캡처가 가리기 이전 compositor 캐시를 사용하던 문제도 fresh surface 캡처로 고쳤다. 가짜 로컬 사이트만 사용했으며 외부 사이트·사용자 로그인은 조작하지 않았다.

## 검증·GC

단위 CLI 검증과 실제 Electron CLI e2e4개(입력·클릭·캡처, 비밀값 변경 전후 PNG 동등, debugger 점유, 다른 일감/탭/닫힌 탭)를 확인한다. 핵심 회귀 변이와 전체 고정 tree 검증 결과는 아래 완료 기록에 남긴다.

GC 읽기 전용 진단 `/tmp/taskminal-46-gc.json`. 기존 r89439e 후보의 정확한 회귀 변이를 수행하며 전역 규칙은 자동 변경하지 않는다. 실패 PNG와 통과 PNG가 같은 /tmp 경로를 사용하던 증거 혼동은 최종 통과 증거를 별도 이름으로 보존해 고쳤다. 부모는 CLI 통합, worker는 독립 보안 리뷰·해당 회귀 수정/검증을 맡았다. 실제 모델은 상속 기본값이며 총토큰·금액은 미측정이다.

## 완료 기록

고정 tree `e51898f79a23e794491eccbd411f238982aabeb1` 별도 복사본에서 전체 종료0: 타입·경계·단위1,192·e2e334 통과, 패키지 전용2 skip(`/tmp/taskminal-46-full.log`). 정확한 보안 회귀 변이2/2검출(`/tmp/taskminal-46-privacy-mutations.log`), 통과 PNG 두 장 SHA256 `a7f8c06fdec6809dccee677ee710fef7f88b36cceac230bc7fbac06c4c223c96` 동일. 부모가 green PNG를 직접 열어 입력값 가림을 확인했다. 실제 사이트 계정·VoiceOver·다른 OS GUI는 별도 확인이다.
