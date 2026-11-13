import { spawn } from 'node:child_process'
import { defaultShell } from '../shared/platform'

// 파일의 연결 앱을 열면 .cmd/.desktop 등이 실행될 수 있다. 명시적인 텍스트 편집기로만 전달한다.
export async function openTextEditor(path: string): Promise<void> {
  const candidates: Array<[string, string[]]> = process.platform === 'darwin'
    ? [['/usr/bin/open', ['-t', path]]]
    : process.platform === 'win32'
      ? [[defaultShell('win32', process.env).replace(/WindowsPowerShell\\v1\.0\\powershell\.exe$/i, 'notepad.exe'), [path]]]
      : [['gedit', ['--', path]], ['kate', ['--', path]], ['mousepad', ['--', path]]]
  for (const [file, args] of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(file, args, { stdio: 'ignore', detached: true })
      child.once('error', () => resolve(false))
      child.once('spawn', () => { child.unref(); resolve(true) })
    })
    if (ok) return
  }
  throw new Error('텍스트 편집기를 열지 못했어요. Linux에서는 gedit, kate 또는 mousepad를 설치해 주세요.')
}
