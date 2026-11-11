# Taskminal 18단계 — 출시 기본기

## Context
docs/plan.md 18단계 · 보드 Release.dc.html (추천안 채택, 2026-11-11). 17단계 데이터 안전이 main(8c256fe)에 병합된 상태에서 시작.
지금: `npm run package` = ad-hoc 서명 · hardened runtime 끔 · `dir` 대상뿐. 다른 Mac 에 옮기면 막히고, 고친 버전을 손으로 다시 건네야 한다. 오류는 `console.error` 6곳뿐이라 사용자가 볼 기록이 없다.
**사용자 결정(2026-11-11, 보드보다 우선):** 업데이트 받는 곳은 NAS 정적 폴더가 아니라 **GitHub Releases** `petercorders/taskminal`(공개 저장소). 원격 추가 · push · 릴리스 게시는 사용자 확인 대상 — 이 단계는 설정 · 산출물 · 로컬 가짜 피드 e2e 까지.
verify: 0.1.0 → 0.1.1 (로컬 피드) 확인 · 받기 · 설치 묻기 e2e · 첫 실행 3장 e2e · 오류 기록 e2e · 패키지 앱(hardened runtime) 실행 e2e. `spctl -a` · 공증은 Developer ID 인증서가 키체인에 들어온 뒤(사용자).
plan-check: 서버 없음 — 업데이트 확인은 GitHub 에서 읽기만 하고, 쓰는 것은 로컬 파일(오류 기록 · 표시 파일 · 설정)뿐이다.

## 스파이크 (2026-11-11, 계획 첫 순서로 돌림)
| 질문 | 결과 |
|---|---|
| Apple Developer 인증서 | `security find-identity -v -p codesigning` = **Apple Development 2개뿐, Developer ID Application 없음** · `notarytool` 프로필 없음 → 서명 · 공증 *실행* 은 사용자 손이 필요한 하위 항목으로 멈춘다. 설정 · 점검 스크립트는 만든다 |
| hardened runtime 에서 spawn-helper · 지킴이(ELECTRON_RUN_AS_NODE) | ad-hoc + `hardenedRuntime: true` + entitlements(allow-jit · allow-unsigned-executable-memory · disable-library-validation) 로 패키지 → `codesign -dv` flags=adhoc,runtime · 패키지 앱을 임시 데이터 폴더 + PATH=/usr/bin:/bin 으로 띄워 지킴이 connected · 셸 응답 · 한글 · 로그인 셸 PATH 확인(`tests/e2e/packaged.spec.ts`, `TASKMINAL_E2E_PACKAGED=1`). disable-library-validation 은 electron-builder 가 ad-hoc + hardened runtime 에 필요하다고 경고 — 빼고 띄워 보지는 않음 |
| Squirrel.Mac 이 ad-hoc 앱을 받나 | electron-updater `MacUpdater.js` 를 읽음: `autoInstallOnAppQuit=false` 면 zip 을 받은 뒤 Squirrel 을 부르지 않고 `update-downloaded` 를 낸다(170~226줄) → 서명 없는 개발 앱에서도 확인 · 받기 · 받기 끝까지 진짜 electron-updater 로 e2e 가능. 설치(`quitAndInstall` → Squirrel)는 서명 확인에서 실패할 것 → 그 실패를 '설치하지 못했어요' 줄로 보여 주는 e2e. 실제 설치 성공은 Developer ID 뒤(미확인) |
| 받은 파일이 쌓이는 곳 | `AppUpdater.getOrCreateDownloadHelper` = `~/Library/Caches/<updaterCacheDirName>` (`ElectronAppAdapter.baseCachePath`). e2e 가 실제 캐시를 쓰지 않게 `TASKMINAL_USER_DATA` 가 있으면 `<userData>/caches` 로 바꾼다 |
| '이 버전 건너뛰기' 지원 | electron-updater 에 없음 → `autoDownload=false` 로 두고 앱이 건너뛴 버전이면 `downloadUpdate` 를 부르지 않는다 |
| 공증 방식 | app-builder-lib `MacTargetHelper.js:246` 이 `APPLE_KEYCHAIN_PROFILE` 을 읽는다 → `xcrun notarytool store-credentials` 로 키체인 프로필을 만들면 저장소 · 환경에 비밀값이 없다 |
| Cloudflare 캐시 | 해당 없음(GitHub Releases) |

## 설계

### 조각
| 조각 | 위치 | 하는 일 |
|---|---|---|
| 업데이트 규칙(순수) | `src/shared/update.ts` | `UpdateView` 모양 · 버전 비교 · 건너뛸지 · 바뀐 것 요약(앞 3줄 + 외 N개) · 오류 글(연결 · 서명 · 디스크) · 막힌 위치(`/Volumes/` = 디스크 이미지 · 쓸 수 없는 폴더) · 6시간 |
| 업데이트 진행 | `src/main/updater.ts` `Updater` | 엔진(electron-updater autoUpdater)을 감싼다. 확인은 **한 번에 하나**(확인 · 받기 중이면 새 확인을 무시), 결과는 `UpdateView` 로 창에 보낸다. 설정(받기 켬 · 건너뛴 버전)은 **매번** main 이 마지막으로 받은 상태에서 읽는다(처음 한 번만 읽지 않는다) |
| 오류 기록(순수) | `src/shared/errlog.ts` | 줄 모양(JSON 한 줄) · 읽기(깨진 줄 버림) · 같은 오류 묶기(횟수 · 마지막 시각) · 7일 · 파일 이름 `main-YYYY-MM-DD.log` |
| 오류 기록 쓰기 | `src/main/errlog.ts` `ErrorLog` | `app.getPath('logs')` = `~/Library/Logs/Taskminal`(e2e 는 `<userData>/logs`). 0600 · 0700, 7일 지난 파일 지움 · 모두 5MB 넘으면 쓰지 않음. 글은 `redact()` 뒤에(17단계 규칙 — 디스크로 가는 새 길). 터미널 출력은 넣지 않는다 |
| 지난번 꺼짐 | `src/main/index.ts` | `crashReporter.start({ uploadToServer: false })`(ready 전). `<userData>/running` 표시 파일 — 시작 때 있으면 '지난번에 갑자기 꺼짐'(오류 기록에도 한 줄), will-quit 에서 지움 |
| 첫 실행 | `src/main/state-file.ts` · `FirstRun.tsx` | `LoadedState.firstRun` = state.json 이 없었고 `<userData>/first-run-seen` 이 없을 때. 안내 3장(모달). 끝내거나 건너뛰면 표시 파일 |
| 화면 | `UpdateBanner`(host-banner 모양 재사용) · `settings/AboutSection.tsx`(정보: 버전 · 업데이트 상태 줄 · 첫 실행 안내 다시 보기 · 오류 기록) · Sidebar 설정 줄 칩 | 아래 장면 |
| 메뉴 · ⌘P | `menu.ts` · `keymap.ts` | 앱 메뉴 'Taskminal 정보' 아래 '업데이트 확인…'. ⌘P '업데이트 확인' · '오류 기록 열기' · '첫 실행 안내 다시 보기'(키 없음) |
| 배포 묶음 | `electron-builder.yml` · `scripts/release.mjs` · `scripts/check-package.mjs` | 아래 '서명 · 배포' |

### 업데이트 — 흐름 (보드 '업데이트 있음' · '최신 · 실패')
- 켜지는 때: 패키지 앱(`app.isPackaged`) · 또는 `TASKMINAL_UPDATE_FEED=<주소>`(e2e · 로컬 확인 — generic provider, `forceDevUpdateConfig`). 개발 실행은 '개발 실행에서는 업데이트를 확인하지 않아요'(disabled).
- 앱을 열고 10초 뒤 한 번 + 6시간마다. 메뉴 · ⌘P · 설정 '지금 확인' 은 바로.
- 새 버전 → 건너뛴 버전이면 'latest' 처럼 보인다(설정 줄에 '0.2.0 건너뜀'). 아니고 '받기' 가 켜져 있으면 뒤에서 받는다(설정 줄 % · MB). 받기가 꺼져 있으면 'available'(설정 줄 '0.2.0 이 나왔어요 · 받기').
- 받기 끝 → 창 위 줄 'Taskminal 0.2.0 을 내려받았어요' + 바뀐 것 요약 + '다시 시작해도 셸은 그대로 이어져요(셸 지킴이)'. [다시 시작해서 설치][바뀐 것 보기][이 버전 건너뛰기][다음에].
  - 다음에 → 줄을 닫고 사이드바 설정 줄에 '● 0.2.0 설치 가능' 칩(누르면 설정 › 정보).
  - 바뀐 것 보기 → GitHub 릴리스 페이지(`https://github.com/petercorders/taskminal/releases/tag/v<버전>`)를 바깥 브라우저로(openLink 길 재사용).
  - 이 버전 건너뛰기 → 설정 `updateSkip` 에 그 버전(상태 저장) · 줄 닫기. 다음 버전이 나오면 다시 알린다.
  - 다시 시작해서 설치 → main 이 `quitting` 을 세우고(before-quit 의 '처음 끌 때 안내' 가 막지 않게) 상태를 쓰고 `quitAndInstall`. 셸은 지킴이에 남는다(16단계). Squirrel 이 실패하면 `quitting` 을 되돌리고 'failed(install)'.
- 실패 → 설정 줄 '✕ 내려받지 못했어요 · <이유> · 6시간 뒤 다시 해요' [다시 시도]. 설치 실패는 창 위 빨간 줄 '0.2.0 을 설치하지 못했어요 · <이유>. 지금 버전(0.1.0)은 그대로예요' [다시 시도][오류 기록 보기]. 모든 실패는 오류 기록에 한 줄.
- 디스크 이미지(`/Volumes/…`)에서 실행 중 → 확인하지 않고 노란 줄 '디스크 이미지 안에서 실행 중이라 업데이트를 받을 수 없어요' [응용 프로그램 폴더로 옮기고 다시 열기(`app.moveToApplicationsFolder`)][다음에].

#### 서버 · 비동기 칸 (plan-check · r5cce92)
- ① 결과를 모를 때: 확인 · 받기가 끝나지 않고 앱이 꺼지면 다음 실행이 처음부터 다시 확인한다(받다 만 파일은 electron-updater 가 버리고 다시 받음). 설치를 눌렀는데 앱이 안 꺼지고 Squirrel 오류도 없으면? → 오류 이벤트가 없으면 결과를 모르는 상태라 설정 줄은 'downloaded' 그대로, 다시 누를 수 있다. 쓰는 쪽은 서버가 아니라 내 설정(건너뛴 버전)뿐.
- ② 다시 시도: 실패 줄의 [다시 시도] = 확인부터 다시(받은 파일이 캐시에 있으면 electron-updater 가 다시 받지 않는다). 6시간 주기도 다음에 다시.
- ③ 이중 입력: '지금 확인' 을 확인 · 받기 중에 다시 누르면 무시(한 번에 하나 — 버튼도 막음). [다시 시작해서 설치] 를 두 번 누르면 두 번째는 무시(installing 표시).
- ④ 취소 · 뒤로: 받기는 뒤에서 돌고 설정 창을 닫아도 계속. [다음에] = 줄만 닫음(받은 것은 남음). 받는 중 '받기' 설정을 끄면 이번 받기는 끝까지 가고 다음부터 묻는다.
- ⑦ 늦게 도착하는 옛 응답: 이벤트는 엔진 하나에서 차례로 온다. 확인 결과가 오기 전에 사용자가 그 버전을 건너뛰면? → 결과를 받을 때 건너뛴 버전을 다시 읽는다(시험). 창이 새로 고침되면 renderer 는 처음에 `update.view()` 로 지금 모습을 받고 이후 이벤트로 — 처음 받은 값이 이벤트보다 늦게 오면 덮지 않는다(`cur ?? v`, 16단계 hostView 와 같은 모양).
- ⑧ 부수 요청: 6시간 주기 · 메뉴 · 시작 확인이 겹쳐도 한 번에 하나(진행 중이면 무시 — 쌓이지 않는다, 시험). 창이 안 보일 때도 돈다 — 6시간에 한 번 · 뒤에서 받기가 목적이라 그대로 둔다.
- ⑨ 처음 한 번만 읽는 값: 받기 켬 · 건너뛴 버전은 main 이 상태를 받을 때마다 바꾸는 값을 매번 읽는다(시작 때 한 번 읽지 않는다, 시험).

### 오류 기록 (보드 '오류 기록' · '오류 없음')
- 쓰는 곳: 상태 저장 실패 · 백업 실패 · 화면을 못 읽음 · 스크롤 저장 · 정리 실패 · 렌더러 사라짐(`render-process-gone` 이유) · 도우미 프로세스 사라짐(`child-process-gone`) · 셸 띄우기 실패(pty spawn) · 셸 지킴이 끊김 · 업데이트 실패 · 지난번 꺼짐. `console.error` 도 그대로 남긴다.
- 줄: `{ t, level: 'error'|'warn', key, msg(사용자 말), detail(원문 코드) }`. 같은 key+msg 는 화면에서 '×14' 로 묶는다.
- 설정 › 정보 › 오류 기록: 거르기 [오류][경고][모두] · 줄마다 [복사](사용자 말 + 원문) · 빈 상태 '최근 7일 동안 오류가 없어요' + 무엇을 모으는지 + [로그 폴더 열기]. 밖으로 보내지 않는다.

### 첫 실행 안내 (보드 '첫 실행 안내')
- 1/3 '일감 하나 = 폴더 하나 + 터미널 묶음' — 홈 폴더(기본) · [다른 폴더 고르기…](pickFolder) → [이 폴더로 첫 일감 만들기 ↩] = 폴더 이름으로 일감 하나(평소 create 길).
- 2/3 'Claude 가 답을 기다릴 때 알려 드려요' — `claude config set --global preferredNotifChannel terminal_bell` [명령 복사 ⌘C]. 앱은 Claude 설정 파일을 고치지 않는다.
- 3/3 '일감과 설정은 이 Mac 에 저장돼요' — 저장 폴더 · 자동 백업 · 밖으로 보내지 않음 [시작하기 ↩].
- Esc · [건너뛰기] = 끝. 끝나면 main 에 알려 `first-run-seen`. 다시 보기: 설정 › 정보 · ⌘P.
- e2e 기본은 `TASKMINAL_FIRST_RUN=seen`(playwright 설정 — 16단계 QUIT_NOTICE 와 같은 방식). 안내를 보는 시험만 지운다.

### 서명 · 배포 (보드 '설치 파일 · 서명')
- `electron-builder.yml`(= `npm run package`, 이 Mac 용): ad-hoc + **hardened runtime 켬** + entitlements(`resources/entitlements.mac.plist`) + `publish: github petercorders/taskminal`(app-update.yml 을 넣기 위해 — 게시는 하지 않음, `--publish never`) · `dir`.
- `npm run release` = `scripts/release.mjs`: ① 키체인에 'Developer ID Application' 인증서가 있는지 ② `APPLE_KEYCHAIN_PROFILE`(기본 `taskminal-notary`) notarytool 프로필이 있는지 — 없으면 무엇을 하라는 명령과 함께 멈춘다(비밀값은 묻지 않는다) ③ electron-builder 에 `-c.mac.identity=<그 인증서>` `-c.mac.notarize=true` `-c.mac.target=dmg -c.mac.target=zip` 를 더해 빌드(`--publish never`) ④ `check-package --release`.
- `check-package --release`: 기존 정적 검사 + `codesign --verify --deep --strict` + 'Developer ID Application' 서명 · 팀 ID 가 spawn-helper · pty.node 까지 같은지 + `spctl --assess --type execute` + `xcrun stapler validate` + dmg · zip · latest-mac.yml 이 있는지.
- 버전: 0.x 동안 기능 = minor, 고침 = patch(보드). 이전 버전 파일은 GitHub 릴리스에 남는다(손으로 되돌리기).

### 앱 종료 4경로
- 앱 종료: 업데이트 엔진은 상태가 없다(받은 파일은 캐시). `running` 표시 파일을 지운다. 설치를 위한 종료도 같은 will-quit(상태 쓰기 · 지킴이 연결만 놓기).
- 창 닫기 · 새로 고침 · 렌더러 충돌: 업데이트 · 오류 기록은 main 에 있다. 새 renderer 는 `update.view()` 로 지금 모습을 받는다. 렌더러 충돌은 오류 기록에 한 줄.
- 열린 대화상자 · then 의 대상이 사라짐: 첫 실행 안내에서 폴더를 고르는 사이 안내가 닫히면(Esc) 고른 결과는 버린다(alive 확인). 오류 기록 [복사]는 그 줄의 글을 누르는 순간에 만든다.

## 시험
단위
- `tests/unit/update.test.ts`: 버전 비교 · 건너뛰기 · 요약 · 오류 글 · 막힌 위치.
- `tests/unit/updater.test.ts`(가짜 엔진): 한 번에 하나(진행 중 확인 무시 — 횟수) · 받기 켬이면 받고 꺼져 있으면 available · 건너뛴 버전이면 받지 않음 · 결과가 온 뒤 건너뛴 버전을 다시 읽음(⑦⑨) · 실패 → failed + 다음 시각 · 설치 중복 무시 · 설치 실패 뒤 다시 누를 수 있음.
- `tests/unit/errlog.test.ts`: 줄 읽기(깨진 줄) · 묶기 · 7일 · 파일 이름.
- `tests/unit/errlog-store.test.ts`(실제 임시 폴더): 0600 · 7일 지난 파일 지움 · 5MB 넘으면 안 씀 · 비밀값 가림.
- `tests/unit/release-config.test.ts`: release 인자(인증서 이름 고르기 · 없으면 안내 글).
- 기존 `check-package` 시험에 `--release` 검사(가짜 codesign · spctl).
e2e `tests/e2e/release.spec.ts`
1. 로컬 피드(시험 안의 http 서버, latest-mac.yml + zip, sha512): 메뉴 '업데이트 확인…' → 받기 % → 창 위 줄 '0.1.1 을 내려받았어요' · 요약 · 받은 zip 이 `<userData>/caches` 에 있음 · 스크린샷.
2. [다음에] → 사이드바 칩 '0.1.1 설치 가능' · 칩 → 설정 › 정보.
3. [이 버전 건너뛰기] → 다시 실행하면 확인해도 줄이 안 뜸 · 설정 줄 '건너뜀'.
4. [다시 시작해서 설치] → 서명 없는 개발 앱이라 Squirrel 이 실패 → 빨간 줄 '설치하지 못했어요' · 앱은 그대로 · 오류 기록에 한 줄.
5. 피드가 404 · 연결 거절 → 설정 줄 '✕ … 다시 시도' · [다시 시도] 로 확인이 다시 감(서버가 받은 요청 수).
6. 첫 실행: state.json 없음 → 안내 1/3 · 홈 폴더로 첫 일감 · 2/3 명령 복사(클립보드) · 3/3 → 다시 켜면 안 뜸 · ⌘P '첫 실행 안내 다시 보기'. Esc 로 건너뛰기도.
7. 오류 기록: 상태 저장 실패를 일으켜(state.json 자리에 폴더) 설정 › 정보 › 오류 기록에 묶인 줄 · 복사 · 거르기 · 빈 상태.
8. 지난번 꺼짐: `running` 표시 파일을 남기고 시작 → 파란 줄 · [오류 기록 보기].
`tests/e2e/packaged.spec.ts`(스파이크에서 만든 것): 패키지 앱 실행 — `TASKMINAL_E2E_PACKAGED=1`.

## 순서 → verify
1. 스파이크(끝) → 이 문서.
2. update · errlog 순수 시험 → 구현 → vitest.
3. Updater · ErrorLog main 시험 → 구현 → vitest.
4. main 연결(IPC · preload · 메뉴 · crashReporter · running · first-run) → typecheck · 경계.
5. 화면(배너 · 정보 칸 · 칩 · 첫 실행) → e2e release.spec · 스크린샷 직접 보기 · 기존 e2e 전체.
6. 배포 묶음(release.mjs · check-package --release · yml publish) → 단위 · `npm run package` · 패키지 e2e.
7. 변이 확인(핵심 줄) → 전체 검사 → 커밋 → 리뷰 → 고침 커밋 → 병합 → 회고.

## 하지 않는 것 (보드)
Mac App Store · x64/universal/Windows/Linux · 오류 · 사용 통계 밖으로 보내기 · 베타 채널 · 자동 되돌리기. 실제 릴리스 게시 · push(사용자 확인).

## 결과 · 계획과 다르게 한 것
결과: 위 시험 목록 그대로(단위 6파일 · e2e release.spec 8 · packaged.spec 1). 변이 10개 모두 잡음(처음 못 잡은 '받기 실패 뒤엔 설치 안 함' 은 시험을 더해 잡음).
서명 · 공증 실행은 사용자 준비물(Developer ID Application 인증서 · 공증 프로필 `taskminal-notary`)이 없어 `npm run release` 의 준비물 확인에서 멈추는 것까지만 확인했다.

계획과 다르게 한 것
- 업데이트 칸을 설정 › 일반이 아니라 새 칸 설정 › 정보에 뒀다 — 버전 · 업데이트 · 첫 실행 다시 보기 · 오류 기록이 한곳에 모여 '정보' 가 맞다고 봤다.
- 업데이트 줄에 ↩ · Esc 단축키를 달지 않았다 — 창 위 줄은 터미널 입력과 겹쳐 키를 가로채면 셸 입력을 먹는다. 버튼으로만.
- 오류 기록에 ⌘F 찾기를 넣지 않았다 — 7일 · 묶은 줄이라 몇 줄이 안 돼 거르기(오류 · 경고 · 모두)로 충분.
- '다음에' 뒤 칩은 사이드바 아래 새 칸(`.sidebar-foot`)에 뒀다 — 보드가 가리킨 기존 자리가 없었다.
- '지난번 갑자기 꺼짐' 은 Crashpad 덤프가 아니라 `<userData>/running` 표시 파일로 판단한다 — 덤프는 renderer 만 죽어도 생기고, 정상 종료 여부가 사용자가 알고 싶은 것.
- crashReporter 는 임시 userData(`TASKMINAL_USER_DATA`, e2e)에서는 켜지 않는다 — crashpad_handler 가 Playwright 가 연 stdio 파이프를 물고 남아 `app.close()` 가 끝나지 않아 기존 e2e 까지 전부 멈췄다(find.spec 3건으로 확인 · 빼면 2.2초 통과). 꺼짐 안내는 표시 파일이라 e2e 에서도 그대로 시험된다.
- 첫 실행 1장은 홈 폴더 + '다른 폴더 고르기…' 만 — 첫 실행엔 최근 폴더가 없다.
- `app-update.yml` 검사를 `check-package` 기본 검사가 아니라 `--release` 로 옮겼다 — electron-builder 는 macOS 에서 dmg · zip 대상일 때만 이 파일을 넣고(`PublishManager` onAfterPack), `npm run package` 는 dir 대상이다. 같은 이유로 이 파일이 없는 패키징본은 업데이트를 '확인하지 않음'(disabled)으로 둔다(packaged.spec 에서 확인) — 6시간마다 실패를 쌓지 않게.
- e2e 5번은 404 만 시험했다(연결 거절은 단위 시험의 오류 글 · failed 흐름이 같은 길).
- 실제 설치 성공(Squirrel 교체 · 다시 열림) · spctl · 공증은 Developer ID 가 생긴 뒤 사용자 확인 대상. 서명 없는 개발 앱에서 설치가 실패하는 길만 e2e 로 봤다.
- entitlements 의 `disable-library-validation` 은 남겼다 — 빼고 서명한 앱에서 node-pty 가 뜨는지는 Developer ID 서명 뒤에야 볼 수 있어 시험하지 않았다.
- 시험 쪽 함정 두 가지를 고쳤다: 사이드바는 상태 읽기 중에도 그려지고 그때 온 명령은 버려지므로(App `runCommand` 의 loading 막음) 읽기가 끝난 화면까지 기다린다 · 메뉴로 연 설정은 열린 걸 본 뒤 Esc.
- 메뉴 ↔ 키 표 대조 시험(menu.test · keys.spec)은 키 없는 메뉴 항목(업데이트 확인…)을 빼고 비교하고, 키 없는 항목이 그것 하나뿐인지 따로 본다.
