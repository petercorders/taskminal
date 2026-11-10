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

## 결과 (2026-11-10) — 패키지 정적 검사까지 · 실행 미확인

`npm run package` → `dist/mac-arm64/Taskminal.app`(262MB, arm64, ad-hoc 서명 `Identifier=io.peterbong.taskminal` · `codesign --verify --deep --strict` 통과) → `check-package` 통과. 단위: check-package 12 · pty +1 (전체 285) · 변이 5/5 + 리뷰 반영 5/5.

**돌려야 할 목록 (사용자 지시 "지금 실제 테스트는 하지마" 로 미실행 · /Applications 설치는 사용자 확인 대상)**
1. `TASKMINAL_USER_DATA=$(mktemp -d) open -n dist/mac-arm64/Taskminal.app --env …` 또는 `dist/mac-arm64/Taskminal.app/Contents/MacOS/Taskminal` 를 임시 데이터 폴더로 → 셸이 뜸(spawn-helper) · `which node` · `echo 한글` · 셸 통합(pane 머리의 명령 표시 · OSC 7 폴더) · Dock 아이콘
2. 네이티브 모듈 Electron ABI: `ELECTRON_RUN_AS_NODE=1 dist/mac-arm64/Taskminal.app/Contents/MacOS/Taskminal -e "require('<앱>/Contents/Resources/app.asar.unpacked/node_modules/node-pty').spawn('/bin/zsh',[],{}).kill()"`
3. Finder 에서 더블클릭(환경 변수 없음 — 실제 데이터 폴더를 쓰므로 사용자 확인 뒤) → PATH(`which node`) · 한글
4. `/Applications` 복사(사용자 확인 뒤): `ditto dist/mac-arm64/Taskminal.app /Applications/Taskminal.app`. ad-hoc 서명(개발자 인증서 없음) — 직접 빌드한 것은 격리 표시가 없어 그냥 열리고, 다른 Mac 으로 옮기면 우클릭 › 열기
5. hardened runtime 을 끈 ad-hoc 서명으로 실제로 뜨는지(1 과 함께)

계획과 다르게 한 것:
- 아이콘 출력은 `build/` 가 아니라 `resources/icon/` 에 두고 커밋 — 개발 Dock 아이콘이 빌드 없이 보이게.
- Finder 최소 환경 시험은 처음에 '기존 시험이 봄' 으로 건너뛰었다가 리뷰 지적으로 추가(PATH 그대로 · LANG 넣음). PATH 자체는 로그인 셸(-l)이 만든다(실행 확인 목록 1 · 3).
- 정적 검사 ⑥ 의 arm64 확인은 `file` 대신 `lipo -archs`(출력이 아키텍처 이름만이라 판정이 단순). ④ 는 `prebuilds/darwin-arm64` 고정이 아니라 node-pty 가 찾는 순서(build/Release → build/Debug → prebuilds)의 첫 곳. 계획에 없던 ⑦ 셸 폴더의 목록 밖 파일 · ⑧ `codesign --verify` 를 더했다.
- 서명: 계획은 '서명 안 함(identity null)' 이었으나 리뷰가 번들 서명이 깨진 채(`Identifier=Electron`) 남는 것을 짚어 ad-hoc(`identity: "-"`) + `hardenedRuntime: false`(ad-hoc 에 켜면 라이브러리 확인으로 안 뜰 수 있다는 electron-builder 경고).
- extraResources 에 점 파일 거르기(`**/.*`)를 넣었다가 변이로 필요 없음을 확인하고 뺐다(electron-builder 기본이 점 파일을 포함). 대신 리뷰 반영으로 `.zsh_history` · `.zcompdump*` · `.zsh_sessions` 를 빼는 거르기를 넣었다 — 심어 둔 `.zsh_history` 가 .app 에 안 들어감을 실제 빌드로 확인.
- afterPack 의 spawn-helper 0755 는 postinstall 이 이미 고친 권한을 다시 주는 방어 — `npm ci --ignore-scripts` 같은 경우를 위해 남김(지금 빌드에서는 없어도 통과).
- `@electron/asar` 를 직접 devDependency 로(check-package 가 씀).
- npm audit: electron-builder 의 빌드 도구 의존성(minimatch)에 moderate 6건 — 앱에 들어가지 않음, 강제 업그레이드 안 함.

## 리뷰 (/code-review medium, 2026-11-10) — 8건 중 7건 반영
| 지적 | 처리 |
|---|---|
| `identity: null` → 번들 서명 깨짐 · `Identifier=Electron` | ad-hoc 서명 + hardenedRuntime 끔, check-package 에 `codesign --verify` |
| `resources/shell` 의 `.zsh_history` 가 .app 에 실릴 수 있음 | extraResources 거르기 + check-package 가 목록 밖 파일을 문제로 |
| afterPack 이 build/Release 의 spawn-helper 를 안 고침 | build/Release · build/Debug · prebuilds 모두 0755 |
| check-package 가 prebuilds 고정 | node-pty 찾는 순서를 따름(통과 못 할 앱 · 잘못 통과할 앱 둘 다 시험) |
| CFBundleIconFile 없으면 icon.icns 로 통과 | 키가 없으면 문제 |
| 계획의 이름 확인 · `file` 과 다름 | CFBundleName 확인 추가, lipo 는 '계획과 다르게 한 것' 에 |
| Finder 최소 환경 시험 약속만 | 시험 추가 |
| asarUnpack 이 node-pty 전체(약 1.1MB) | **반영 안 함** — node-pty 의 로드 경로가 바뀌는 변경이라 앱을 띄워 확인해야 하는데 지금은 실행 금지. 262MB 중 1.1MB. 실행 확인 때 같이 볼 후보 |
