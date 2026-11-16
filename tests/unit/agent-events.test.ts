// 51단계: main 의 에이전트 기록 파일 감시 — 읽은 위치 · 반쪽 줄 · 자르기 · 지우기 · 시작 때 마지막 사건.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSignal } from '../../src/shared/agent-hooks'
import { AgentEvents, writeHookFiles } from '../../src/main/agent-events'

let root: string
let dir: string
let got: Array<[string, AgentSignal]>
let ev: AgentEvents
const line = (sec: number, event: string, type = ''): string => `v1\t${sec}\tclaude\t${event}\t${type}\n`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tm-agent-events-'))
  dir = join(root, 'agent-events')
  got = []
})
afterEach(() => {
  ev?.stop()
  rmSync(root, { recursive: true, force: true })
})
const make = (maxBytes?: number, pollMs = 0): AgentEvents => {
  ev = new AgentEvents({ dir, onSignal: (p, s) => got.push([p, s]), ...(maxBytes ? { maxBytes } : {}), pollMs })
  ev.start()
  return ev
}

describe('AgentEvents', () => {
  it('폴더를 0700 으로 만들고, 남은 파일의 마지막 사건을 알리지 않고 기억한다', () => {
    mkdirSync(dir)
    writeFileSync(join(dir, 'p1.log'), line(10, 'UserPromptSubmit') + line(11, 'Stop'))
    make()
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(got).toEqual([])
    expect(ev.last()).toEqual({ p1: { agent: 'claude', phase: 'done', at: 11000 } })
  })

  it('덧붙은 줄 중 마지막 사건만 알리고, 반쪽 줄은 줄바꿈이 올 때까지 기다린다', () => {
    make()
    const f = ev.fileFor('p1')!
    appendFileSync(f, line(1, 'UserPromptSubmit') + line(2, 'PermissionRequest') + 'v1\t3\tclaude\tSt')
    ev.poll('p1')
    expect(got).toEqual([['p1', { agent: 'claude', phase: 'permission', at: 2000 }]])
    appendFileSync(f, 'op\t\n')
    ev.poll('p1')
    expect(got.at(-1)).toEqual(['p1', { agent: 'claude', phase: 'done', at: 3000 }])
    ev.poll('p1')
    expect(got).toHaveLength(2) // 새 줄이 없으면 알리지 않는다
  })

  it('파일이 지워졌다 다시 생기면 처음부터 읽는다', () => {
    make()
    const f = ev.fileFor('p1')!
    appendFileSync(f, line(1, 'UserPromptSubmit') + line(2, 'Stop'))
    ev.poll('p1')
    rmSync(f)
    appendFileSync(f, line(3, 'UserPromptSubmit'))
    ev.poll('p1')
    expect(got.at(-1)).toEqual(['p1', { agent: 'claude', phase: 'working', at: 3000 }])
  })

  it('상한을 넘으면 마지막 줄만 남기고 줄이며, 그 뒤 덧붙인 줄도 읽는다', () => {
    make(512)
    const f = ev.fileFor('p1')!
    for (let i = 0; i < 40; i++) appendFileSync(f, line(100 + i, i % 2 ? 'Stop' : 'UserPromptSubmit'))
    ev.poll('p1')
    expect(statSync(f).size).toBeLessThan(512)
    expect(readFileSync(f, 'utf8')).toBe(line(139, 'Stop'))
    appendFileSync(f, line(200, 'PermissionRequest'))
    ev.poll('p1')
    expect(got.at(-1)).toEqual(['p1', { agent: 'claude', phase: 'permission', at: 200000 }])
  })

  it('끝 쪽만 읽을 때 잘린 첫 줄은 사건으로 세지 않는다 — 잘린 자리가 우연히 사건 줄 모양이어도', () => {
    make(512)
    const f = ev.fileFor('p1')!
    // 줄 전체는 'garbage-v1⇥…' 라 사건이 아니지만, 끝 512바이트가 'v1' 에서 시작하면 잘린 조각은 사건 줄처럼 보인다
    const looksLike = line(7, 'PermissionRequest')
    appendFileSync(f, 'garbage-' + looksLike + 'n'.repeat(512 - looksLike.length - 1) + '\n')
    ev.poll('p1')
    expect(got).toEqual([])
    expect(ev.last()).toEqual({})
  })

  it('pane 을 잊으면 파일 · 기억을 지우고, 상태에 없는 pane 의 파일도 지운다', () => {
    make()
    for (const p of ['p1', 'p2', 'p3']) appendFileSync(ev.fileFor(p)!, line(1, 'Stop'))
    for (const p of ['p1', 'p2', 'p3']) ev.poll(p)
    ev.forget('p1')
    expect(existsSync(join(dir, 'p1.log'))).toBe(false)
    ev.keepOnly(new Set(['p2']))
    expect(existsSync(join(dir, 'p2.log'))).toBe(true)
    expect(existsSync(join(dir, 'p3.log'))).toBe(false)
    expect(Object.keys(ev.last())).toEqual(['p2'])
  })

  it('pane id 모양이 아니면 경로를 만들지 않는다', () => {
    make()
    expect(ev.fileFor('../x')).toBeNull()
    expect(ev.fileFor('')).toBeNull()
  })

  // 폴더 감시(FSEvents)는 부하가 크면 늦거나 감시 직후 생긴 파일을 놓친다(병렬 시험에서 3초 안에 못 받은 적 있음) — 주기 읽기가 받친다
  it('폴더 감시 · 주기 읽기로 따로 부르지 않아도 알린다', async () => {
    make(undefined, 300)
    appendFileSync(ev.fileFor('p9')!, line(5, 'UserPromptSubmit'))
    await vi.waitFor(() => expect(got.at(-1)?.[0]).toBe('p9'), { timeout: 3000, interval: 50 })
    appendFileSync(ev.fileFor('p9')!, line(6, 'Stop'))
    await vi.waitFor(() => expect(got.at(-1)).toEqual(['p9', { agent: 'claude', phase: 'done', at: 6000 }]), { timeout: 3000, interval: 50 })
  })
})

describe('훅 파일 쓰기', () => {
  it('폴더 0700 · 스크립트 0700 · 설정 0600, 내용이 같으면 다시 쓰지 않고 다르면 바꾼다', () => {
    const hooks = join(root, 'agent-hooks')
    const a = writeHookFiles(hooks)
    expect(statSync(hooks).mode & 0o777).toBe(0o700)
    expect(statSync(a.claudeHook).mode & 0o777).toBe(0o700)
    expect(statSync(a.codexNotify).mode & 0o777).toBe(0o700)
    expect(statSync(a.claudeSettings).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(a.claudeSettings, 'utf8')).hooks.Stop[0].hooks[0].command).toContain(a.claudeHook)
    // 프로젝트 statusLine 이 있는 곳에서 쓰는 훅만 든 설정 — 감싸기가 이름(-hooks)으로 찾는다
    expect(a.claudeHooksOnly).toBe(a.claudeSettings.replace(/\.json$/, '-hooks.json'))
    const only = JSON.parse(readFileSync(a.claudeHooksOnly, 'utf8'))
    expect(only.statusLine).toBeUndefined()
    expect(only.hooks.Stop[0].hooks[0].command).toContain(a.claudeHook)
    expect(statSync(a.claudeHooksOnly).mode & 0o777).toBe(0o600)
    const ino = statSync(a.claudeHook).ino
    writeHookFiles(hooks)
    expect(statSync(a.claudeHook).ino).toBe(ino)
    writeFileSync(a.claudeHook, 'old')
    writeHookFiles(hooks)
    expect(readFileSync(a.claudeHook, 'utf8')).toMatch(/^#!\/bin\/sh/)
  })
})
