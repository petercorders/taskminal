# 15a 명령 끝 macOS 알림 — 11단계에 이미 있음 (문서만)

plan.md 15단계 항목 '명령 끝 macOS 알림' 을 11단계와 겹치는지 대조했다(development.md 6절 지시).

| 15단계 항목이 뜻하는 것 | 11단계에 있는 것 (코드) |
|---|---|
| 오래 걸린 명령이 끝나면 알림 | `notifyKind` → `'long'` — 시작(OSC 133;C)을 본 명령이 `longAfterSec`(설정) 넘게 걸리고 끝나면 (`src/shared/notify.ts`) |
| 실패로 끝나면 알림 | `'fail'` — exit ≠ 0 |
| 입력을 기다리면(벨 · OSC 9/777) | `'wait'` |
| 셸이 닫히면 | `'exit'` (pty 끝에서) |
| 배너 · 소리 따로 켜고 끔 | 설정 '알림 · 활동' 표 (`settings.notify[kind].banner/sound`) |
| 보고 있는 pane 은 조용히 | `muteViewed` |
| 알림을 누르면 그 pane 으로 | `Notification.onclick` → `task/select` + `pane/focus` (App.tsx `deliver`) |
| 시험 | `tests/unit/notify.test.ts` · `tests/e2e/activity.spec.ts` |

결론: 새로 만들 것 없음. 코드 변경 없음 · 시험 변경 없음.
계획과 다르게 한 것: 없음(문서만으로 닫는다는 것이 계획).
