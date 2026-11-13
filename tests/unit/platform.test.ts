import { describe, expect, it } from 'vitest'
import { defaultShell, shellArgs, platformUserData, isAbsolutePath, normalizeLocalPath, pathInside } from '../../src/shared/platform'
import { pickShell } from '../../src/shared/pty'
import { socketPath, parseRequest } from '../../src/shared/ptyhost'
import { cliSocketPath } from '../../src/shared/cli'
import { isDangerousTool, codexRequestToEvents } from '../../src/shared/chat'
import { resolveCwd } from '../../src/shared/model'
import { accelFromEvent, accelLabel, commandForKey, nativeAccel, type KeyLike } from '../../src/shared/keymap'

describe('OS별 실행 경로', () => {
  it('Windows는 시스템 PowerShell을 프로필과 함께 열고 로그인 셸 인자를 주지 않는다', () => {
    expect(defaultShell('win32', { SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(shellArgs('win32')).toEqual(['-NoLogo', '-NoExit'])
    expect(shellArgs('linux')).toEqual(['-l'])
    expect(defaultShell('linux', {})).toBe('/bin/bash')
    expect(defaultShell('darwin', {})).toBe('/bin/zsh')
  })
  it('셸 허용 목록은 절대 Windows 경로도 허용하고 임의 경로는 거절한다', () => {
    expect(pickShell('C:\\allowed.exe', 'C:\\fallback.exe', ['C:\\allowed.exe'])).toBe('C:\\allowed.exe')
    expect(pickShell('C:\\evil.exe', 'C:\\fallback.exe', ['C:\\allowed.exe'])).toBe('C:\\fallback.exe')
    expect(isAbsolutePath('C:\\Users\\me')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
    expect(isAbsolutePath('C:relative')).toBe(false)
  })
  it('Windows IPC는 파일이 아닌 사용자 데이터별 named pipe이고 두 기능이 겹치지 않는다', () => {
    const hash = (s: string) => s.includes('other') ? 'bbbbbbbbbbbbbbbbbbbbbbbb' : 'aaaaaaaaaaaaaaaaaaaaaaaa'
    expect(socketPath('C:\\me', 1, 'C:\\tmp', hash, 'win32')).toBe('\\\\.\\pipe\\taskminal-aaaaaaaaaaaaaaaaaaaaaaaa-ptyhost-v1')
    expect(cliSocketPath('C:\\me', 'C:\\tmp', hash, 'win32')).toBe('\\\\.\\pipe\\taskminal-aaaaaaaaaaaaaaaaaaaaaaaa-cli')
    expect(socketPath('C:\\other', 1, '', hash, 'win32')).not.toBe(socketPath('C:\\me', 1, '', hash, 'win32'))
    expect(socketPath('/tmp/user', 1, '/tmp', hash, 'linux')).toBe('/tmp/user/ptyhost-v1.sock')
  })
  it('지킴이 요청에서 Windows 절대 경로를 받고 drive-relative 경로는 거절한다', () => {
    const req = { op: 'spawn', paneId: 'p', file: 'C:\\Windows\\powershell.exe', cwd: 'C:\\Users\\me', args: [], env: {}, cols: 80, rows: 24 }
    expect(parseRequest(req)).toEqual(req)
    expect(parseRequest({ ...req, cwd: 'C:relative' })).toBeNull()
  })
  it('앱 밖 CLI가 Electron과 같은 OS별 데이터 폴더를 찾는다', () => {
    expect(platformUserData('linux', '/home/a', { XDG_CONFIG_HOME: '/custom' })).toBe('/custom/Taskminal')
    expect(platformUserData('linux', '/home/a', {})).toBe('/home/a/.config/Taskminal')
    expect(platformUserData('win32', 'C:\\Users\\a', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' })).toBe('C:\\Users\\a\\AppData\\Roaming\\Taskminal')
    expect(platformUserData('darwin', '/Users/a', {})).toBe('/Users/a/Library/Application Support/Taskminal')
  })
  it('Windows drive/UNC를 보존하고 ..와 다른 drive를 폴더 밖으로 판정한다', () => {
    expect(normalizeLocalPath('C:\\repo\\a\\..\\b')).toBe('C:/repo/b')
    expect(normalizeLocalPath('\\\\server\\share\\a\\..\\b')).toBe('//server/share/b')
    expect(resolveCwd('C:\\repo', 'D:\\other')).toBe('D:/other')
    expect(pathInside('C:\\repo', 'c:/repo/file.ts')).toBe(true)
    expect(pathInside('C:\\repo', 'C:\\repo\\..\\outside.ts')).toBe(false)
    expect(pathInside('C:\\repo', 'C:\\repository\\file.ts')).toBe(false)
    expect(pathInside('C:\\repo', 'D:\\repo\\a')).toBe(false)
    expect(isDangerousTool('Edit', { file_path: 'C:\\outside.ts' }, 'C:\\repo')).toBe(true)
    expect(codexRequestToEvents('item/commandExecution/requestApproval', 1, { cwd: 'D:\\other', command: 'echo hi' }, 'C:\\repo')[0]).toMatchObject({ danger: true })
    expect(codexRequestToEvents('item/fileChange/requestApproval', 2, { grantRoot: 'C:\\repo\\..\\outside' }, 'C:\\repo')[0]).toMatchObject({ danger: true })
  })
  it('Windows/Linux Ctrl 단축키는 저장된 Command 의미를 유지하고 터미널 CtrlC는 가로채지 않는다', () => {
    const key: KeyLike = { key: 'p', code: 'KeyP', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, isComposing: false }
    expect(commandForKey(key, undefined, 'control')).toBe('palette')
    expect(commandForKey(Object.create(key) as KeyLike, undefined, 'control')).toBe('palette') // 실제 KeyboardEvent는 prototype getter
    expect(commandForKey({ ...key, code: 'KeyT' }, undefined, 'control')).toBe('new-tab')
    expect(commandForKey({ ...key, code: 'Comma' }, undefined, 'control')).toBe('settings')
    expect(commandForKey({ ...key, code: 'KeyC' }, undefined, 'control')).toBeNull()
    expect(commandForKey(key)).toBeNull()
    expect(accelFromEvent({ ...key, shiftKey: true }, 'control')).toBe('Shift+Command+P')
    expect(accelLabel('Shift+Command+P', 'control')).toBe('Shift+Ctrl+P')
    expect(nativeAccel('Control+Command+Right', 'control')).toBe('Super+Control+Right')
  })
})
