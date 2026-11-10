# Taskminal 14단계 — 패키징 · 설치

## Context
docs/plan.md 14단계: electron-builder .app(arm64) · asarUnpack(node-pty) · 앱 아이콘 · /Applications 설치 · Finder 실행 시 PATH/LANG. verify: 설치한 .app 을 Finder 에서 실행해 셸 · `which node` · 한글 확인.
**사용자 지시(2026-11-10)**: "지금 실제 테스트는 하지마" — 앱을 띄우는 확인(e2e · .app 실행 · `npm run dev`)은 하지 않는다. 빌드 · 패키징까지는 한다. `/Applications` 설치는 원래도 사용자 확인 대상.
→ 이 단계의 verify 는 **패키지 정적 검사**(만든 .app 안을 읽어 보는 스크립트)까지 하고, 실행 확인은 '돌려야 할 목록' 으로 남긴다.

## 설계
| 항목 | 결정 |
|---|---|
| 도구 | `electron-builder` 26.17.0(devDependency, 2026-09-26 — 2주 넘은 버전), 설정은 `electron-builder.yml` |
| 대상 | `mac.target: dir` (arm64) — `dist/mac-arm64/Taskminal.app`. dmg · zip · 서명 · 공증은 하지 않음(개인 설치용, 원격 없음). `identity: null` 로 서명 시도도 끔 |
| 넣을 파일 | `out/**` · `package.json` · node-pty(dependencies). `asarUnpack: node_modules/node-pty/**` — 네이티브 `.node` · `spawn-helper` 는 asar 밖에서만 실행된다 |
| spawn-helper 권한 | npm 패키지에 실행 권한이 빠져 있다(postinstall 이 고침). 패키징이 권한을 그대로 옮기는지 믿지 않고 `afterPack` 훅(`scripts/after-pack.cjs`)이 .app 안의 `spawn-helper` 를 0755 로 |
| 셸 통합 | `extraResources: resources/shell → shell` → `Contents/Resources/shell/zsh/.zshrc` (main 은 `app.isPackaged` 면 `process.resourcesPath/shell/zsh`, 이미 있음). 점 파일(.zshrc …)이 빠지지 않는지 정적 검사로 본다 |
| 아이콘 | `resources/icon/icon.svg` → `scripts/build-icon.sh`: `qlmanage` 로 1024 PNG(투명, 2026-11-10 렌더 확인) → `sips` 로 16~1024 @1x·@2x → `iconutil` → `resources/icon/icon.icns` + `icon.png`(개발 Dock) — 만든 파일도 커밋(빌드마다 만들지 않게). electron-builder `mac.icon: resources/icon/icon.icns` |
| 개발 모드 Dock | `!app.isPackaged` 면 `app.dock.setIcon(<앱>/resources/icon/icon.png)` (없으면 건너뜀) |
| Finder 실행 | 셸은 이미 `-l`(로그인 셸 → /etc/zprofile path_helper · 사용자 .zprofile 로 PATH), LANG 이 없거나 UTF-8 이 아니면 `en_US.UTF-8`(shellEnv, 11단계 시험 있음). main 이 부르는 외부 명령은 절대 경로(`/usr/sbin/lsof`). → 새 코드 없음, 단위 시험으로 Finder 같은 최소 환경(PATH=/usr/bin:/bin, LANG 없음)을 한 번 더 본다 |
| 앱 정보 | `appId: io.peterbong.taskminal` · `productName: Taskminal` · `mac.category: public.app-category.developer-tools` · `LSMinimumSystemVersion` 기본 · `NSRequiresAquaSystemAppearance: false` |
| 정적 검사 | `scripts/check-package.mjs <앱 경로>`: ① Info.plist(CFBundleIdentifier · 이름 · 아이콘 파일) ② `Resources/icon.icns` 있음 ③ `app.asar` 안에 `out/main/index.js` · `out/preload/index.js` · `out/renderer/index.html` (asar 목록) ④ `app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/{pty.node,spawn-helper}` 있고 spawn-helper 0755 ⑤ `Resources/shell/zsh/{.zshrc,.zshenv,.zprofile,.zlogin,taskminal-hooks.zsh}` ⑥ `file` 로 `Contents/MacOS/Taskminal` 이 arm64. 문제마다 한 줄, 있으면 exit 1. `npm run package` = build → electron-builder → check-package |

plan-check: 서버 없음 — 로컬 파일만 만드는 패키징 단계

## 종료 경로 · 데이터
패키징은 앱 동작을 바꾸지 않는다(개발 Dock 아이콘 한 줄 외). 설치본의 userData 는 개발 실행과 같은 `~/Library/Application Support/Taskminal` — 설치 · 실행은 사용자 확인 뒤.

## 시험
- 단위: `tests/unit/check-package.test.ts` — 가짜 .app 폴더(임시)로 check-package 의 판정(빠진 셸 통합 파일 · spawn-helper 권한 0644 · 빠진 asar 항목)을 본다. 모두 갖춘 가짜는 통과.
- 단위: shellEnv 에 Finder 같은 최소 환경 → LANG=en_US.UTF-8 · PATH 그대로(이미 있으면 건너뜀).
- 실제 패키지: `npm run package` → check-package 통과(빌드만, 실행 없음).

## 돌려야 할 목록 (사용자 지시로 미실행)
- `open dist/mac-arm64/Taskminal.app` 를 **임시 데이터 폴더**(`TASKMINAL_USER_DATA`)로 → 셸 뜸 · `which node` · `echo 한글` · 셸 통합(명령 표시) · 아이콘 Dock
- Finder 에서 더블클릭(환경 변수 없음) — 사용자 확인 뒤, 실제 데이터 폴더
- `/Applications` 복사 — 사용자 확인 뒤

## 순서 → verify
1. 아이콘 스크립트 → resources/icon/icon.icns 의 크기 목록(`iconutil -c iconset` 역변환)으로 확인
2. check-package 시험(빨강) → 스크립트 → vitest
3. electron-builder 설치 · 설정 · afterPack → `npm run package` → check-package 통과
4. 개발 Dock 아이콘 · shellEnv 시험 → typecheck · vitest
5. 변이(check-package 핵심 줄) → full-check(FULL_CHECK_NO_E2E=1) → 커밋 → 리뷰 → 문서 → main ff → 회고

## 하지 않는 것
- 서명 · 공증 · dmg · 자동 업데이트 · x64/universal · `/Applications` 설치(사용자 확인) · 설치본 실행(사용자 지시)
