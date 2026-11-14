import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, open, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { RemoteWorkspaceServer } from './workspace-server'
import { openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs'

async function main() {
  const options: Record<string, string> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]!, v = args[i + 1]
    if (!['--root','--data','--port'].includes(k) || options[k] || v === undefined) throw Error('사용법: taskminal-server --root <허용 폴더> --data <서버 기록 폴더> [--port 4788]')
    options[k] = v
  }
  if (!options['--root'] || !options['--data']) throw Error('--root와 --data가 필요합니다')
  const root = await realpath(options['--root'])
  await mkdir(options['--data'], {recursive: true, mode: 0o700}); const dir = await realpath(options['--data']); await chmod(dir, 0o700)
  const rel = relative(root, dir)
  if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) throw Error('서버 기록 폴더는 허용 작업 폴더 밖에 두세요')
  // Fail closed on stale locks too: recovery is an explicit operator action after checking the PID.
  // Acquire before touching token/journal so a second listener cannot corrupt the running owner.
  const lock = join(dir, 'server.lock')
  let fd: number
  try { fd = openSync(lock, 'wx', 0o600) } catch { throw Error('이 기록 폴더의 서버가 실행 중이거나 잠금 확인이 필요합니다. server.lock의 PID를 확인해 주세요') }
  writeFileSync(fd, String(process.pid)); closeSync(fd)
  process.once('exit', () => { try { unlinkSync(lock) } catch {} })
  const port = Number(options['--port'] ?? 4788); if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('포트 번호')
  const file = join(dir, 'token')
  let token: string
  try { const f = await open(file, 'wx', 0o600); try { token = randomBytes(32).toString('hex'); await f.writeFile(token); await f.sync() } finally { await f.close() } }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; const {constants} = await import('node:fs'); const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { const s = await f.stat(); if (!s.isFile() || s.size !== 64) throw Error('서버 토큰 파일 형식'); token = await f.readFile('utf8'); await f.chmod(0o600) } finally { await f.close() } }
  if (!/^[a-f0-9]{64}$/.test(token!)) throw Error('서버 토큰 파일 형식')
  const service = new RemoteWorkspaceServer(root, dir)
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control','no-store')
    const supplied = req.headers.authorization?.replace(/^Bearer /,'') || ''
    if (req.headers.origin || req.method !== 'POST' || req.url !== '/rpc' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { res.writeHead(403); res.end('{"error":"인증된 서버 연결이 필요합니다"}'); return }
    try {
      if (!req.headers['content-type']?.startsWith('application/json')) throw Error('JSON 요청이 필요합니다')
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of req) { size += chunk.length; if (size > 4_000_000) throw Error('요청 크기 한도'); chunks.push(chunk) }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {method: unknown; args: unknown}
      const data = await service.call(payload.method, payload.args)
      res.end(JSON.stringify({data: data ?? null}))
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({error: e instanceof Error ? e.message : '원격 요청을 확인하지 못했어요'})) }
  })
  server.requestTimeout = 20000; server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  process.stdout.write(JSON.stringify({url: `http://127.0.0.1:${(server.address() as {port: number}).port}`, tokenFile: file}) + '\n')
  const stop = () => { service.dispose(); server.close(); setTimeout(() => process.exit(0), 300).unref() }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
}
main().catch(e => { process.stderr.write((e instanceof Error ? e.message : '서버를 시작하지 못했어요') + '\n'); process.exit(1) })
