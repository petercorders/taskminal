// 순수 OS 선택 — renderer에서도 Node API 없이 검사할 수 있다.
export const isAbsolutePath = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)

export function normalizeLocalPath(path: string): string {
  const drive = /^[A-Za-z]:[\\/]/.test(path)
  const unc = /^\\\\[^\\]+\\[^\\]+/.test(path)
  const text = drive || unc ? path.replace(/\\/g, '/') : path
  const share = unc ? /^\/\/[^/]+\/[^/]+/.exec(text)![0] : ''
  const prefix = drive ? text.slice(0, 3) : unc ? share + '/' : text.startsWith('/') ? '/' : text === '~' || text.startsWith('~/') ? '~' : ''
  const rest = drive ? text.slice(3) : unc ? text.slice(share.length) : prefix === '~' ? text.slice(1) : text
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop()
      else if (!prefix || prefix === '~') parts.push('..')
    } else parts.push(part)
  }
  if (prefix === '~') return parts.length ? '~/' + parts.join('/') : '~'
  return prefix + parts.join('/') || '.'
}

export function pathInside(root: string, path: string): boolean {
  const windows = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\')
  const key = (value: string) => {
    const text = normalizeLocalPath(value).replace(/\/+$/, '')
    return windows ? text.toLowerCase() : text
  }
  const parent = key(root), child = key(path)
  return child === parent || child.startsWith(parent + '/')
}

export function defaultShell(platform: string, env: Record<string, string | undefined>): string {
  if (platform === 'win32') return `${env['SystemRoot'] || env['SYSTEMROOT'] || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  return env['SHELL'] || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

export const shellArgs = (platform: string): string[] => platform === 'win32' ? ['-NoLogo', '-NoExit'] : ['-l']

export function platformUserData(platform: string, home: string, env: Record<string, string | undefined>): string {
  if (platform === 'win32') return `${env['APPDATA'] || home + '\\AppData\\Roaming'}\\Taskminal`
  return platform === 'darwin' ? `${home}/Library/Application Support/Taskminal` : `${env['XDG_CONFIG_HOME'] || home + '/.config'}/Taskminal`
}
