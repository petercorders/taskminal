import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '../shared/ipc'
import { shortcutTable, type AppCommand, type Shortcut } from '../shared/keymap'

// ⌥⌘Q 모두 끝내기는 창이 없어도 돌아야 해서 renderer 를 거치지 않고 main 이 바로 받는다 (index.ts 가 정한다)
let quitAllHandler: () => void = () => {}
export const onQuitAll = (fn: () => void): void => {
  quitAllHandler = fn
}
// 24단계: '명령줄 도구 설치…' — 사용자가 눌러야만 /usr/local/bin 에 링크를 만든다 (index.ts 가 정한다)
let cliInstallHandler: () => void = () => {}
export const onCliInstall = (fn: () => void): void => {
  cliInstallHandler = fn
}

/** 우리 명령 항목: 단축키는 보여 주기만 한다(registerAccelerator: false) — 실제 키는 renderer 가 같은 표로 처리한다.
 *  네이티브로도 등록하면 키 하나에 명령이 두 번 돈다. 누르면 그 창의 renderer 에 명령을 보낸다. */
function itemOf(table: readonly Shortcut[], command: AppCommand): MenuItemConstructorOptions {
  const s = table.find((x) => x.command === command)!
  return {
    id: command,
    label: s.label,
    ...(s.accel ? { accelerator: s.accel } : {}),
    registerAccelerator: false,
    click: (_item, win) => {
      // 창이 하나뿐인 앱 — 포커스된 창이 없으면(다른 앱이 앞) 그 창으로
      const target = win instanceof BrowserWindow ? win : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])
      target?.webContents.send(IPC.appCommand, command)
    },
  }
}

/** 앱 메뉴. Electron 기본 메뉴에 있던 새로 고침(⌘R)은 모든 셸을 끝내므로 넣지 않는다. */
export function buildAppMenu(dev: boolean, keys: Readonly<Record<string, string>> = {}): Menu {
  const table = shortcutTable(keys)
  const item = (command: AppCommand) => itemOf(table, command)
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        // 18단계: 누르면 확인하고 설정 › 정보에서 결과를 보여 준다
        { ...item('update-check'), label: '업데이트 확인…' },
        { id: 'cli-install', label: '명령줄 도구 설치…', click: () => cliInstallHandler() },
        { type: 'separator' },
        item('settings'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // 16단계: ⌘Q 는 앱만 끈다 — 셸은 셸 지킴이에 남는다
        { role: 'quit', label: `${app.name} 끝내기 (셸은 계속 돌아요)` },
        { ...item('quit-all'), label: '셸까지 모두 끝내기…', click: () => quitAllHandler() },
      ],
    },
    {
      // 26단계: 대화를 ⌘P 밖에서도 찾게 — 이름도 '셸' → '파일'(대화 · 터미널 모두 여기서 연다)
      label: '파일',
      submenu: [
        item('new-task'),
        item('chat-new'),
        item('chat-new-codex'),
        item('new-tab'),
        { type: 'separator' },
        item('chat-split'),
        item('chat-split-codex'),
        { type: 'separator' },
        item('palette'),
        { type: 'separator' },
        item('split-right'),
        item('split-down'),
        { type: 'separator' },
        item('close-pane'),
        { role: 'close', label: '창 닫기', accelerator: 'Shift+Command+W' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' },
        { role: 'redo', label: '실행 복귀' },
        { type: 'separator' },
        { role: 'cut', label: '잘라내기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '모두 선택' },
        { type: 'separator' },
        item('clear'),
        item('find'),
        item('global-find'),
      ],
    },
    {
      label: '보기',
      submenu: [
        item('font-bigger'),
        item('font-smaller'),
        item('font-reset'),
        { type: 'separator' },
        item('history'),
        item('resume-show'),
        item('notes'),
        { type: 'separator' },
        item('shell-toggle'),
        item('chat-terminal'),
        item('review'),
        { type: 'separator' },
        item('mask-toggle'),
        item('mask-next'),
        item('mask-prev'),
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
        ...(dev ? [{ type: 'separator' } as const, { role: 'toggleDevTools', label: '개발자 도구' } as const] : []),
      ],
    },
    {
      label: '창',
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: '최소화' },
        { role: 'zoom', label: '확대/축소' },
        { type: 'separator' },
        item('next-tab'),
        item('prev-tab'),
        {
          label: '탭으로 가기',
          submenu: [...([1, 2, 3, 4, 5, 6, 7, 8] as const).map((n) => item(`tab-${n}`)), item('last-tab')],
        },
        { type: 'separator' },
        item('next-pane'),
        item('prev-pane'),
        { type: 'separator' },
        item('next-task'),
        item('prev-task'),
        item('next-attention'),
        item('status-next'),
        item('status-prev'),
        { type: 'separator' },
        item('archive'),
        item('archive-open'),
        item('weekly'),
        item('remote-reconnect'),
        { type: 'separator' },
        { role: 'front', label: '모두 앞으로 가져오기' },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

/** keys: 설정에서 바꾼 단축키 — 바뀔 때마다 다시 만든다(메뉴는 표시만, 실제 키는 renderer) */
export function installAppMenu(keys: Readonly<Record<string, string>> = {}): void {
  Menu.setApplicationMenu(buildAppMenu(!app.isPackaged && Boolean(process.env['ELECTRON_RENDERER_URL']), keys))
}
