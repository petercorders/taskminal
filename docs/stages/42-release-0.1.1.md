# 42 — 0.1.1 서명·공증·다운로드 공개

최종 결과: 0.1.1 소스 `150cf3a`의 서명·공증은 승인됐다. 이후 사용자 요청으로 Intel Mac·Windows·Linux 지원을 추가하면서 공개 버전을 **0.1.2로 대체**했다. 0.1.1 릴리스는 만들지 않았으며, 실제 공개 결과와 검증은 `43-multi-platform.md`에 기록한다. 예전 403 계약 차단은 해소됐다.

사용자 승인(2026-11-14): “빌드 공증 진행해줘”, “이 버전으로 이제 페이지에 올리자”. 기존 자율 진행 지시를 유지한다. 하네스 흐름으로 검사·GC·커밋·push를 진행한다.

## 배포 대상과 순서 → verify

1. 검증 완료한 최신 기능 브랜치 `stage-36-40-orca-followup`의 cb0c15e를 기반으로 package/lock 버전을0.1.1로 구분하고 source commit을 고정한다. verify: 이전 최종 typecheck/경계/단위1,141/e2e316 종료0 기록, release-config/check-package 단위·현재 타입/단위 검사. 버전 외 앱 동작 수정 없음.
2. 실행 중인 `dist/mac-arm64/Taskminal.app`와 /Applications 앱을 덮지 않도록 별도 release output을 쓴다. 기존 release-config의 builderArgs/인증서·키체인 프로필로 동일 빌드/서명/공증 명령을 실행한다. verify: Apple Accepted·codesign strict·stapler·spctl·check-package --release·artifact version/hash와 update manifest. 실제 /Applications 설치나 사용자 데이터 변경 없음.
3. 서명된 새 app을 임시 userData로 실행하고 셸·한글·PATH·일감 브라우저/파일/계정/GitHub UI의 기존 실제 패키지 시험을 수행한다. 별도 output을 시험하도록 executable path override를 추가한다. verify: 실제 서명본 packaged e2e, 사용자 CLI로 메시지 자동 전송 없음.
4. GitHub Releases에 v0.1.1 draft를 만들고 dmg/zip/blockmap/latest-mac.yml/checksum을 업로드한다. verify: 원격 asset 크기·hash·manifest 일치 후 공개, latest API와 다운로드 확인. release target은 고정한 기능 브랜치 commit이며 main에 앱 기능을 자동 병합하지 않는다.
5. 공개 release가 검증된 뒤 홈페이지 site.js RELEASE=ready를 준비·로컬 화면/연결 검사한 다음 홈페이지 main의 해당 파일만 업데이트한다. verify: 특정 Pages run을 commit SHA로 고정해 성공·실제 도메인 응답·다운로드 링크·OS별 문구 확인. 사용자 요청이 홈페이지 운영 게시를 명시적으로 승인한다. main의 앱 코드 병합은 범위 밖이다.
6. 실제 결과·미검증·GC를 문서/메모리에 기록하고 feature branch에 commit/push한다. 홈페이지 commit도 기능 브랜치에 반영해 다음 merge에서 되돌리지 않게 한다.

## 실패·재시도·수명

- 결과를 모를 때: notary 제출 ID로 현재 상태를 조회하며 같은 artifact를 자동 재제출하지 않는다. GitHub draft/asset/tag/Pages commit SHA와 실제 목록을 확인하고 모르는 상태를 완료로 표시하지 않는다.
- 다시 시도: 공증 실패는 log를 읽고 원인 수정 후 새 artifact·제출을 만든다. 업로드는 기존 asset 이름·크기/hash부터 대조해 누락만 올린다. draft는 검사 성공 전 공개하지 않는다. homepage 실패는 정확한 배포 run과 공개 응답을 확인한다.
- 이중 입력: release version/tag/source SHA/output을 고정하고 빌드·공개를 한 번에 하나씩 진행한다. 기존 release/tag가 있으면 먼저 조회하고 임의 덮어쓰기/force tag 없음.
- 취소·뒤로·닫기: 기존 실행 앱·실제 데이터는 보존하고 임시 실행만 종료한다. 이미 올린 draft/제출을 몰래 삭제하지 않는다. 공개 뒤 실패면 홈페이지 ready를 이전 상태로 돌리는 별도 commit을 준비하고 실제 공개 상태부터 알린다.
- 충돌: 홈페이지 update는 최신 main 파일 blob SHA를 읽고 조건부로 쓴다. 409/412 충돌 뒤 다시 저장은 새 내용을 읽고 RELEASE 한 줄만 다시 적용하며 타인의 변경을 덮지 않는다.
- 느린 조회·부수 요청: 요청 번호·단계와 SHA로 오래된 응답을 구별한다. 부수 요청은 작업마다 한 번에 하나, 안 보일 때 쌓이지 않게 한다. 건너뛴 요청은 앞 요청이 끝난 뒤 다시 읽는다.
- 초기 값: 처음 한 번 읽은 release/main 상태를 게시 결정에 재사용하지 않고 최신 목록·asset·blob SHA를 다시 확인한다.
- 부분 성공: 준비→빌드→제출→Accepted→staple→파일 업로드→공개→홈페이지 순으로 결과를 기록한다. 연결 중간 실패는 앞에서 만든 submission/release id를 재사용해 상태를 확인하고 진행 중 표시를 유지한다.
- 실제 대조: 실제 Apple notarytool·codesign/spctl/stapler, 실제 서명 앱/임시 셸, GitHub asset/API, GitHub Pages 도메인을 대조한다. 실제 계정 대화·VoiceOver/IME/Retina·다른 Mac 설치는 실제 대조 안 함.
