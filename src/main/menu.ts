import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '../shared/ipc'
import { SHORTCUTS, type AppCommand } from '../shared/keymap'

/** 우리 명령 항목: 단축키는 보여 주기만 한다(registerAccelerator: false) — 실제 키는 renderer 가 같은 표로 처리한다.
 *  네이티브로도 등록하면 키 하나에 명령이 두 번 돈다. 누르면 그 창의 renderer 에 명령을 보낸다. */
function item(command: AppCommand): MenuItemConstructorOptions {
  const s = SHORTCUTS.find((x) => x.command === command)!
  return {
    id: command,
    label: s.label,
    accelerator: s.accel,
    registerAccelerator: false,
    click: (_item, win) => {
      // 창이 하나뿐인 앱 — 포커스된 창이 없으면(다른 앱이 앞) 그 창으로
      const target = win instanceof BrowserWindow ? win : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])
      target?.webContents.send(IPC.appCommand, command)
    },
  }
}

/** 앱 메뉴. Electron 기본 메뉴에 있던 새로 고침(⌘R)은 모든 셸을 끝내므로 넣지 않는다. */
export function buildAppMenu(dev: boolean): Menu {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: '셸',
      submenu: [
        item('new-task'),
        item('new-tab'),
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
      ],
    },
    {
      label: '보기',
      submenu: [
        item('font-bigger'),
        item('font-smaller'),
        item('font-reset'),
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
        { type: 'separator' },
        { role: 'front', label: '모두 앞으로 가져오기' },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

export function installAppMenu(): void {
  Menu.setApplicationMenu(buildAppMenu(!app.isPackaged && Boolean(process.env['ELECTRON_RENDERER_URL'])))
}
