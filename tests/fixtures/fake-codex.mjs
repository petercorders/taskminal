#!/usr/bin/env node
// e2e 용 가짜 codex (22단계) — `codex app-server` 의 줄마다 JSON-RPC 를 스파이크 · 스키마 모양대로 흉내 낸다(tests/fixtures/codex/*.jsonl).
// 보낸 글의 낱말로 대본을 고른다. FAKE_CODEX_LOG 가 있으면 인자 · 받은 줄을 JSON 한 줄씩 남긴다.
// FAKE_CODEX_NOLOGIN=1 이면 account/read 가 로그인 없음을 돌려준다(스파이크에서 본 모양).
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const log = (o) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(o) + '\n')
log({ argv: args, cwd: process.cwd() })
if (args[0] !== 'app-server') {
  process.stderr.write('fake codex: app-server 만 흉내 내요\n')
  process.exit(2)
}

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const reply = (id, result) => out({ id, result })
const note = (method, params) => out({ method, params })

let threadId = null
let threadSeq = 0
let turnSeq = 0
let itemSeq = 0
let reqSeq = 1000
const waiting = new Map() // 서버가 보낸 요청 id → 답을 받으면 부를 함수
let current = null // { id, interrupted() }

function startTurn(text, images) {
  const turnId = `turn-${process.pid}-${++turnSeq}`
  const t0 = Date.now()
  const end = (status, error = null) => {
    if (current?.id !== turnId) return
    current = null
    note('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { modelContextWindow: 200000, last: { inputTokens: 30000, outputTokens: 2000 }, total: {} } })
    note('turn/completed', { threadId, turn: { id: turnId, status, error, durationMs: Date.now() - t0, items: [] } })
  }
  current = { id: turnId, interrupted: () => end('interrupted') }
  note('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } })
  const say = (t) => note('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `it-${++itemSeq}`, text: t } })
  const ask = (method, params, then) => {
    const id = ++reqSeq
    waiting.set(id, then)
    out({ id, method, params: { threadId, turnId, ...params } })
  }

  if (text.includes('crash')) {
    say('곧 끝나요')
    process.stderr.write('fake codex crash: boom\n')
    setTimeout(() => process.exit(3), 50)
    return turnId
  }
  if (text.includes('slow')) {
    say('오래 걸리는 일을 시작해요')
    return turnId // turn/interrupt 를 기다린다
  }
  if (text.includes('perm')) {
    const command = text.includes('danger') ? 'rm -rf build' : 'touch made.txt'
    const item = { type: 'commandExecution', id: `it-${++itemSeq}`, command, cwd: process.cwd(), status: 'inProgress' }
    note('item/started', { threadId, turnId, item })
    ask('item/commandExecution/requestApproval', { itemId: item.id, command, cwd: process.cwd(), reason: '파일 만들기' }, (res) => {
      const ok = res?.decision === 'accept' || res?.decision === 'acceptForSession'
      note('item/completed', { threadId, turnId, item: { ...item, status: ok ? 'completed' : 'declined', exitCode: ok ? 0 : null, aggregatedOutput: ok ? 'made' : '' } })
      say(ok ? `허락 받음 · ${command}` : `거절됨 · ${res?.decision}`)
      end('completed')
    })
    return turnId
  }
  if (text.includes('ask')) {
    ask(
      'item/tool/requestUserInput',
      { itemId: `it-${++itemSeq}`, questions: [{ id: 'q-color', header: '색', question: '어느 색이 좋아요?', isOther: true, isSecret: false, options: [{ label: '빨강', description: '따뜻한' }, { label: '파랑', description: '차가운' }] }] },
      (res) => {
        say(`고른 색: ${(res?.answers?.['q-color']?.answers ?? []).join(', ')}`)
        end('completed')
      },
    )
    return turnId
  }
  const item = { type: 'commandExecution', id: `it-${++itemSeq}`, command: 'cat a.ts', cwd: process.cwd(), status: 'inProgress' }
  note('item/started', { threadId, turnId, item })
  note('item/completed', { threadId, turnId, item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'export const a = 1' } })
  say(`echo: ${text}${images ? ` · 그림 ${images}` : ''}`)
  end('completed')
  return turnId
}

const thread = (id, extra = {}) => ({ thread: { id, model: 'gpt-fake', cwd: process.cwd(), ...extra } })

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  log({ stdin: o })
  if (o.method === undefined && o.id !== undefined) {
    const then = waiting.get(o.id)
    waiting.delete(o.id)
    then?.(o.result)
    return
  }
  const p = o.params ?? {}
  switch (o.method) {
    case 'initialize':
      return reply(o.id, { userAgent: 'fake-codex/0.0.0', platformFamily: 'unix', platformOs: 'macos' })
    case 'initialized':
      return
    case 'account/read':
      return reply(o.id, process.env.FAKE_CODEX_NOLOGIN === '1' ? { account: null, requiresOpenaiAuth: true } : { account: { type: 'chatgpt', email: 'fake@example.com', planType: 'plus' }, requiresOpenaiAuth: true })
    case 'thread/start':
      threadId = `th-${process.pid}-${++threadSeq}`
      return reply(o.id, thread(threadId))
    case 'thread/resume':
      threadId = p.threadId
      return reply(o.id, thread(threadId))
    case 'thread/fork':
      threadId = `fork-${process.pid}-${++threadSeq}`
      return reply(o.id, thread(threadId, { forkedFromId: p.threadId }))
    case 'turn/start': {
      const text = (p.input ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('')
      const images = (p.input ?? []).filter((x) => x.type === 'localImage').length
      const id = `turn-${process.pid}-${turnSeq + 1}`
      reply(o.id, { turn: { id, status: 'inProgress', items: [] } })
      startTurn(text, images)
      return
    }
    case 'turn/interrupt':
      reply(o.id, {})
      current?.interrupted()
      return
    default:
      if (o.id !== undefined) out({ id: o.id, error: { code: -32601, message: `fake: ${o.method}` } })
  }
})
rl.on('close', () => process.exit(0))
