// `taskminal` 명령 (24단계) — 앱의 Electron 을 node 로(ELECTRON_RUN_AS_NODE) 돌린다(out/main/cli.js).
// 인자 → 소켓(<userData>/cli.sock) 한 줄 JSON → 답을 찍고 종료 코드. 앱이 꺼져 있으면 3.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CLI_PROTOCOL, cliSocketPath, EXIT, HELP, parseArgs, type CliReply } from '../../shared/cli'
import { isPaneId } from '../../shared/pty'

function socketPath(env: NodeJS.ProcessEnv): string {
  if (env['TASKMINAL_SOCKET']) return env['TASKMINAL_SOCKET']
  const userData = env['TASKMINAL_USER_DATA'] || join(homedir(), 'Library', 'Application Support', 'Taskminal')
  return cliSocketPath(userData, tmpdir(), (s) => createHash('sha1').update(s).digest('hex'))
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string }
    return `taskminal ${pkg.version ?? '?'} (프로토콜 ${CLI_PROTOCOL})`
  } catch {
    return `taskminal (프로토콜 ${CLI_PROTOCOL})`
  }
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.kind === 'help') {
    process.stdout.write(HELP + '\n')
    return process.exit(EXIT.ok)
  }
  if (parsed.kind === 'version') {
    process.stdout.write(version() + '\n')
    return process.exit(EXIT.ok)
  }
  if (parsed.kind === 'usage') {
    process.stderr.write(`taskminal: ${parsed.error}\n`)
    return process.exit(EXIT.usage)
  }
  // 상대 경로 폴더는 이 명령을 친 폴더 기준 — 앱은 그 폴더를 모른다
  if (parsed.req.op === 'task.new' && parsed.req.cwd && !parsed.req.cwd.startsWith('/') && parsed.req.cwd !== '~' && !parsed.req.cwd.startsWith('~/')) parsed.req.cwd = resolve(parsed.req.cwd)
  const self = process.env['TASKMINAL_PANE_ID']
  const body = { v: CLI_PROTOCOL, ...parsed.req, ...(isPaneId(self) ? { self } : {}) }
  const sock = connect(socketPath(process.env))
  let buf = ''
  let answered = false
  sock.setEncoding('utf8')
  sock.on('connect', () => sock.write(JSON.stringify(body) + '\n'))
  sock.on('data', (c: string) => (buf += c))
  sock.on('error', (e: NodeJS.ErrnoException) => {
    if (answered) return
    answered = true
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      process.stderr.write('taskminal: Taskminal 이 실행 중이 아니에요 — 앱을 연 뒤 다시 해 주세요\n')
      return process.exit(EXIT.down)
    }
    process.stderr.write(`taskminal: 앱에 연결하지 못했어요: ${e.message}\n`)
    process.exit(EXIT.error)
  })
  sock.on('close', () => {
    if (answered) return
    answered = true
    let r: CliReply
    try {
      r = JSON.parse(buf) as CliReply
    } catch {
      process.stderr.write('taskminal: 앱과 연결이 끊겼어요 — 반영됐는지 `taskminal list` 로 확인해 주세요\n')
      return process.exit(EXIT.error)
    }
    if (r.ok) {
      const out = parsed.json ? JSON.stringify(r.data ?? { text: r.text ?? '' }, null, 2) : r.text
      if (out) process.stdout.write(out + '\n')
      return process.exit(r.exit ?? EXIT.ok)
    }
    process.stderr.write(`taskminal: ${r.error}\n`)
    if (r.candidates?.length) process.stderr.write(r.candidates.map((c) => `  ${c}`).join('\n') + '\n')
    process.exit(r.exit ?? EXIT.error)
  })
  // Ctrl-C — 연결을 끊으면 앱이 기다림을 버린다
  process.on('SIGINT', () => {
    answered = true
    sock.destroy()
    process.exit(130)
  })
}

main()
