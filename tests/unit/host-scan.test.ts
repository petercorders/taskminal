import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { endOtherHost, listOtherHosts, type HostScanDeps } from '../../src/main/host-scan'
import { endOtherHostError, endOtherHostText, endSentNote, findTarget, HOST_PS_ARGS, isOtherHostTarget, otherHostLine, parseHostProcesses, type OtherHost } from '../../src/shared/host-scan'
import type { HostRequest } from '../../src/shared/ptyhost'

// 61단계 — 이 Mac 의 다른 셸 지킴이 찾기 · 끝내기. 실제 지킴이에는 붙지 않는다(가짜 ps · 가짜 소켓).

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')
const EXE = '/Applications/Taskminal.app/Contents/MacOS/Taskminal'
const JS = '/Applications/Taskminal.app/Contents/Resources/app.asar/out/main/host.js'
const DATA = '/Users/u/Library/Application Support/Taskminal' // 공백이 든 폴더
const row = (pid: number, ppid: number, uid: number, lstart: string, command: string) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(uid).padStart(5)} ${lstart}     ${command}`
const hostRow = (pid: number, data: string, lstart = 'Wed Nov 11 10:25:52 2026', uid = 501) => row(pid, 1, uid, lstart, `${EXE} ${JS} ${data}/ptyhost-v1.sock ${data}`)

describe('parseHostProcesses', () => {
  it('지킴이 줄에서 pid · 시작 시각 · 소켓 · 데이터 폴더(공백 포함)를 읽고, 자식 수를 센다', () => {
    const out = [
      hostRow(100, DATA),
      row(101, 100, 501, 'Wed Nov 11 10:26:00 2026', '-zsh'),
      row(102, 100, 501, 'Wed Nov 11 10:26:01 2026', '/bin/zsh -l'),
      row(103, 1, 501, 'Wed Nov 11 10:26:02 2026', '/usr/bin/some-daemon'),
    ].join('\n')
    expect(parseHostProcesses(out, 501, sha1)).toEqual([
      { pid: 100, startedAt: 'Wed Nov 11 10:25:52 2026', startedMs: new Date(2026, 10, 11, 10, 25, 52).getTime(), sockPath: `${DATA}/ptyhost-v1.sock`, userData: DATA, version: 1, children: 2 },
    ])
  })

  it('데이터 폴더 경로가 길어 임시 폴더에 둔 소켓 꼴도 읽는다 — 해시가 데이터 폴더와 맞을 때만', () => {
    const long = '/Users/u/' + 'a'.repeat(120)
    const sock = `/private/var/folders/x y/T/taskminal-${sha1(long).slice(0, 12)}-v3.sock`
    const good = row(200, 1, 501, 'Thu Nov  5 01:02:03 2026', `${EXE} ${JS} ${sock} ${long}`)
    const bad = row(201, 1, 501, 'Thu Nov  5 01:02:03 2026', `${EXE} ${JS} /tmp/taskminal-0123456789ab-v3.sock ${long}`)
    expect(parseHostProcesses([good, bad].join('\n'), 501, sha1)).toMatchObject([{ pid: 200, sockPath: sock, userData: long, version: 3, startedMs: new Date(2026, 10, 5, 1, 2, 3).getTime() }])
  })

  it('다른 프로그램 · 모양이 다른 줄 · 다른 사용자의 지킴이는 버린다', () => {
    const out = [
      'garbage line',
      '',
      row(300, 1, 501, 'Wed Nov 11 10:25:52 2026', 'grep host.js /tmp/x'),
      row(301, 1, 501, 'Wed Nov 11 10:25:52 2026', `node /repo/host.js /tmp/a/ptyhost-v1.sock /tmp/b`), // 소켓 폴더 ≠ 데이터 폴더
      row(302, 1, 501, 'Wed Nov 11 10:25:52 2026', `${EXE} ${JS} ${DATA}/ptyhost-v1.sock`), // 데이터 폴더 인자 없음
      row(303, 1, 501, 'not a date at all here ok', `${EXE} ${JS} /tmp/d/ptyhost-v1.sock /tmp/d`),
      hostRow(304, '/tmp/other-user', 'Wed Nov 11 10:25:52 2026', 502),
      hostRow(305, '/tmp/mine'),
    ].join('\n')
    expect(parseHostProcesses(out, 501, sha1).map((h) => h.pid)).toEqual([305])
    // uid 를 모르면(Windows) 사용자를 가리지 않는다
    expect(parseHostProcesses(out, null, sha1).map((h) => h.pid)).toEqual([304, 305])
  })

  it('실제 ps 출력에서 방금 띄운 가짜 지킴이(node 스크립트)를 찾는다', async () => {
    if (process.platform === 'win32') return
    const data = join(realpathSync(mkdtempSync(join(tmpdir(), 'tm-host-scan-'))), 'data folder')
    mkdirSync(data)
    const script = join(data, 'host.js')
    writeFileSync(script, 'setTimeout(() => {}, 20000)\n')
    const child = spawn(process.execPath, [script, join(data, 'ptyhost-v1.sock'), data], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 300))
      const out = await new Promise<string>((resolve, reject) =>
        execFile('ps', [...HOST_PS_ARGS], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 }, (e, stdout) => (e ? reject(e) : resolve(stdout))),
      )
      const found = parseHostProcesses(out, process.getuid?.() ?? null, sha1).find((h) => h.pid === child.pid)
      expect(found).toMatchObject({ sockPath: join(data, 'ptyhost-v1.sock'), userData: data, version: 1 })
      expect(Math.abs(found!.startedMs! - Date.now())).toBeLessThan(60_000)
    } finally {
      child.kill('SIGKILL')
    }
  })
})

describe('findTarget · isOtherHostTarget', () => {
  const hosts = parseHostProcesses(hostRow(100, DATA), 501, sha1)
  const target = { pid: 100, startedAt: 'Wed Nov 11 10:25:52 2026', sockPath: `${DATA}/ptyhost-v1.sock` }
  it('같은 pid · 시작 시각 · 소켓일 때만 찾는다', () => {
    expect(findTarget(hosts, target)).toMatchObject({ pid: 100 })
    expect(findTarget(hosts, { ...target, pid: 101 })).toBe('gone')
    expect(findTarget(hosts, { ...target, startedAt: 'Wed Nov 11 10:25:53 2026' })).toBe('changed') // pid 가 다시 쓰였다
    expect(findTarget(hosts, { ...target, sockPath: '/tmp/x/ptyhost-v1.sock' })).toBe('changed')
  })
  it('renderer 가 준 대상의 모양을 본다', () => {
    expect(isOtherHostTarget(target)).toBe(true)
    for (const bad of [null, {}, { ...target, pid: 0 }, { ...target, pid: 1.5 }, { ...target, startedAt: '' }, { ...target, startedAt: 'x'.repeat(41) }, { ...target, sockPath: 'a\0b' }, { ...target, sockPath: 5 }]) {
      expect(isOtherHostTarget(bad)).toBe(false)
    }
  })
})

interface Fake {
  deps: HostScanDeps
  asked: Array<{ sock: string; ops: string[] }>
}
/** 가짜 ps · 가짜 지킴이들. hosts: 소켓 → 답(null = 답 없음) */
function fake(psOut: () => string, hosts: Record<string, { sessions: unknown[]; clients?: number } | null>, selfSock = '/self/ptyhost-v1.sock'): Fake {
  const asked: Fake['asked'] = []
  return {
    asked,
    deps: {
      ps: async () => psOut(),
      ask: async (sock: string, reqs: HostRequest[]) => {
        asked.push({ sock, ops: reqs.map((r) => r.op) })
        const h = hosts[sock]
        if (!h) return null
        return reqs.map((r, i) => {
          if (r.op === 'list') return { id: i + 1, ok: true, sessions: h.sessions }
          if (r.op === 'stats') return { id: i + 1, ok: true, sessions: h.sessions.length, ...(h.clients !== undefined ? { clients: h.clients } : {}) }
          return { id: i + 1, ok: true }
        })
      },
      selfSock,
      uid: 501,
      hash: sha1,
      mask: (t) => t.replace(/sk-[a-z0-9]+/g, '••••'),
      protocol: 1,
    },
  }
}
const session = (paneId: string, extra: Record<string, unknown> = {}) => ({ paneId, pid: 1, startedAt: 0, lastOutputAt: 0, attached: false, running: false, unseen: { waiting: false }, detachedMs: 0, ...extra })
const sock = (data: string) => `${data}/ptyhost-v1.sock`

describe('listOtherHosts', () => {
  it('지금 앱의 지킴이는 빼고, 오래된 것부터, 셸 수 · 실행 중인 명령(가려서) · 붙은 앱 여부를 채운다', async () => {
    const out = [hostRow(10, '/self'), hostRow(11, '/tmp/new', 'Wed Nov 18 09:00:00 2026'), hostRow(12, '/tmp/old', 'Wed Nov 11 09:00:00 2026'), hostRow(13, '/tmp/dead', 'Thu Nov 12 09:00:00 2026')].join('\n')
    const f = fake(() => out, {
      [sock('/tmp/new')]: { sessions: [session('a', { running: true, command: 'npm run dev sk-abc123' }), session('b'), session('c', { exited: { exitCode: 0, signal: null } })], clients: 1 },
      [sock('/tmp/old')]: { sessions: [session('d', { attached: true })], clients: 2 },
      [sock('/tmp/dead')]: null,
    })
    const list = await listOtherHosts(f.deps)
    expect(list.map((h) => h.pid)).toEqual([12, 13, 11])
    expect(list[0]).toMatchObject({ state: 'ok', shells: 1, commands: [], attached: true })
    expect(list[1]).toMatchObject({ state: 'silent' })
    expect(list[1]!.shells).toBeUndefined()
    expect(list[2]).toMatchObject({ state: 'ok', shells: 2, commands: ['npm run dev ••••'], attached: false })
    expect(f.asked.every((a) => a.sock !== '/self/ptyhost-v1.sock')).toBe(true)
    expect(f.asked.flatMap((a) => a.ops)).not.toContain('shutdown') // 읽기만
  })

  it('연결 수를 모르는 옛 지킴이는 셸에 붙은 손님이 있는지로 가린다', async () => {
    const f = fake(() => [hostRow(11, '/tmp/a'), hostRow(12, '/tmp/b')].join('\n'), {
      [sock('/tmp/a')]: { sessions: [session('a', { attached: true })] },
      [sock('/tmp/b')]: { sessions: [session('b')] },
    })
    expect((await listOtherHosts(f.deps)).map((h) => h.attached)).toEqual([true, false])
  })
})

describe('endOtherHost', () => {
  const target = { pid: 11, startedAt: 'Wed Nov 11 10:25:52 2026', sockPath: sock('/tmp/a') }
  const shutdowns = (f: Fake) => f.asked.filter((a) => a.ops.includes('shutdown'))

  it('같은 프로세스가 그대로 있고 붙은 앱이 없으면 shutdown 을 한 번 보낸다', async () => {
    const f = fake(() => hostRow(11, '/tmp/a'), { [sock('/tmp/a')]: { sessions: [session('a')], clients: 1 } })
    expect(await endOtherHost(f.deps, target)).toEqual({ ok: true })
    expect(shutdowns(f)).toEqual([{ sock: sock('/tmp/a'), ops: ['shutdown'] }])
  })

  it('그 사이 사라졌으면 아무것도 보내지 않는다', async () => {
    const f = fake(() => hostRow(99, '/tmp/zzz'), { [sock('/tmp/a')]: { sessions: [session('a')], clients: 1 } })
    expect(await endOtherHost(f.deps, target)).toEqual({ ok: false, reason: 'gone' })
    expect(f.asked).toEqual([])
  })

  it('pid 가 다른 프로세스에 다시 쓰였으면(시작 시각 · 소켓이 다름) 보내지 않는다', async () => {
    const later = fake(() => hostRow(11, '/tmp/a', 'Wed Nov 18 08:00:00 2026'), { [sock('/tmp/a')]: { sessions: [session('a')], clients: 1 } })
    expect(await endOtherHost(later.deps, target)).toEqual({ ok: false, reason: 'changed' })
    const moved = fake(() => hostRow(11, '/tmp/b'), { [sock('/tmp/a')]: { sessions: [session('a')], clients: 1 }, [sock('/tmp/b')]: { sessions: [], clients: 1 } })
    expect(await endOtherHost(moved.deps, target)).toEqual({ ok: false, reason: 'changed' })
    expect([...later.asked, ...moved.asked]).toEqual([])
  })

  it('그 사이 다른 앱이 붙었으면 보내지 않는다', async () => {
    const f = fake(() => hostRow(11, '/tmp/a'), { [sock('/tmp/a')]: { sessions: [session('a', { attached: true })], clients: 2 } })
    expect(await endOtherHost(f.deps, target)).toEqual({ ok: false, reason: 'attached' })
    expect(shutdowns(f)).toEqual([])
  })

  it('답이 없는 지킴이는 끝내지 않는다 (신호를 보내지 않는다)', async () => {
    const f = fake(() => hostRow(11, '/tmp/a'), { [sock('/tmp/a')]: null })
    expect(await endOtherHost(f.deps, target)).toEqual({ ok: false, reason: 'silent' })
    expect(shutdowns(f)).toEqual([])
  })

  it('shutdown 의 답이 안 왔어도 다시 훑어 사라졌으면 끝난 것으로 본다 · 남아 있으면 응답 없음', async () => {
    let alive = true
    const f = fake(() => (alive ? hostRow(11, '/tmp/a') : ''), { [sock('/tmp/a')]: { sessions: [], clients: 1 } })
    const ask = f.deps.ask
    f.deps.ask = async (s, reqs) => {
      if (reqs[0]!.op !== 'shutdown') return ask(s, reqs)
      f.asked.push({ sock: s, ops: ['shutdown'] })
      alive = false // 셸이 없던 지킴이는 답을 쓰자마자 끝난다
      return null
    }
    expect(await endOtherHost(f.deps, target)).toEqual({ ok: true })
    const stuck = fake(() => hostRow(11, '/tmp/a'), { [sock('/tmp/a')]: { sessions: [], clients: 1 } })
    const ask2 = stuck.deps.ask
    stuck.deps.ask = async (s, reqs) => (reqs[0]!.op === 'shutdown' ? null : ask2(s, reqs))
    expect(await endOtherHost(stuck.deps, target)).toEqual({ ok: false, reason: 'silent' })
  })

  it('지금 앱의 지킴이는 대상이 될 수 없다', async () => {
    const f = fake(() => hostRow(11, '/tmp/a'), { [sock('/tmp/a')]: { sessions: [], clients: 1 } }, sock('/tmp/a'))
    expect(await endOtherHost(f.deps, target)).toEqual({ ok: false, reason: 'gone' })
    expect(f.asked).toEqual([])
  })
})

describe('otherHostLine · 확인 글', () => {
  const base: OtherHost = { pid: 11, startedAt: 'x', startedMs: 1_000_000, sockPath: '/Users/u/data/ptyhost-v1.sock', userData: '/Users/u/data', version: 1, children: 2, state: 'ok', shells: 2, commands: [], attached: false }
  const DAY = 86_400_000
  it('집 폴더는 ~ 로, 이틀부터는 날 수로 보인다', () => {
    expect(otherHostLine(base, 1_000_000 + 3 * DAY + 5000, '/Users/u')).toEqual({ folder: '~/data', summary: '3일째 · 셸 2개', detail: '실행 중인 명령 없음', canEnd: true })
    expect(otherHostLine(base, 1_000_000 + 90_000, '/Users/u/').summary).toBe('1분 30초째 · 셸 2개')
    expect(otherHostLine({ ...base, userData: '/Users/uu/data' }, 2_000_000, '/Users/u').folder).toBe('/Users/uu/data')
    expect(otherHostLine({ ...base, startedMs: null }, 2_000_000, '').summary).toBe('시작 시각 모름 · 셸 2개')
  })
  it('실행 중인 명령을 보이고, 붙은 앱이 있거나 답이 없으면 끝낼 수 없다', () => {
    expect(otherHostLine({ ...base, commands: ['npm run dev', 'vim'] }, 2_000_000, '/Users/u')).toMatchObject({ detail: '실행 중: npm run dev · vim', canEnd: true })
    expect(otherHostLine({ ...base, attached: true }, 2_000_000, '/Users/u')).toMatchObject({ canEnd: false, detail: '다른 Taskminal 이 쓰고 있어요 — 그 앱에서 끝내요' })
    expect(otherHostLine({ ...base, state: 'silent', shells: undefined }, 2_000_000, '/Users/u')).toMatchObject({ canEnd: false, summary: '16분 40초째 · 프로세스 2개', detail: '응답이 없어 여기서 끝내지 않아요 (프로세스 11)' })
  })
  it('확인 글은 무엇이 끝나는지 말한다', () => {
    expect(endOtherHostText(base)).toBe('이 지킴이와 셸 2개가 끝나요. 되돌릴 수 없어요.')
    expect(endOtherHostText({ ...base, commands: ['a', 'b'] })).toBe('이 지킴이와 셸 2개가 끝나요 — 실행 중인 명령 2개도. 되돌릴 수 없어요.')
    expect(endOtherHostError('changed')).toContain('끝내지 않았어요')
  })
  it('끝내라고 보낸 뒤: 목록에서 사라지면 끝남, 3초 뒤에도 있으면 아직 떠 있다고 알린다', () => {
    const sent = { pid: 11, startedAt: 'x', sockPath: base.sockPath }
    expect(endSentNote(sent, [], false)).toBe('지킴이와 셸을 끝냈어요.')
    expect(endSentNote(sent, [base], false)).toBe('끝내는 중이에요…')
    expect(endSentNote(sent, [base], true)).toContain('아직 떠 있어요')
    expect(endSentNote(sent, [{ ...base, startedAt: 'y' }], true)).toBe('지킴이와 셸을 끝냈어요.') // 같은 pid 의 다른 프로세스
  })
})
