#!/usr/bin/env node
// e2e 용 가짜 claude (21단계) — stream-json 입출력을 스파이크에서 본 모양 그대로 흉내 낸다(tests/fixtures/claude/*.jsonl).
// 보낸 글의 낱말로 대본을 고른다. FAKE_CLAUDE_LOG 가 있으면 인자 · 받은 줄을 JSON 한 줄씩 남긴다.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const log = (o) => process.env.FAKE_CLAUDE_LOG && appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + '\n')
log({ argv: args, cwd: process.cwd() })

const resumeAt = args.indexOf('--resume')
// 22단계: --fork-session 이면 갈라진 새 세션 id (스파이크 tests/fixtures/claude/fork.jsonl)
const sessionId = resumeAt >= 0 && !args.includes('--fork-session') ? args[resumeAt + 1] : `sess-${process.pid}`
const modeAt = args.indexOf('--permission-mode')
let mode = modeAt >= 0 ? args[modeAt + 1] : 'default'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
let uuidSeq = 0
const assistant = (content) => out({ type: 'assistant', uuid: `u-${process.pid}-${++uuidSeq}`, message: { model: 'claude-fake', role: 'assistant', content }, session_id: sessionId })
const result = (extra = {}) =>
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1200,
    terminal_reason: 'completed',
    session_id: sessionId,
    usage: { input_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 50 },
    modelUsage: { 'claude-fake': { contextWindow: 200000 } },
    ...extra,
  })

let inited = false
const waiting = new Map() // request_id → 받으면 부를 함수
let interruptWanted = null
let seq = 0

function init() {
  if (inited) return
  inited = true
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model: 'claude-fake', permissionMode: mode })
}
function ask(request, then) {
  const id = `req-${++seq}`
  waiting.set(id, then)
  out({ type: 'control_request', request_id: id, request })
}

function turn(text, images = 0) {
  init()
  if (text.includes('crash')) {
    assistant([{ type: 'text', text: '곧 끝나요' }])
    process.stderr.write('fake crash: boom\n')
    setTimeout(() => process.exit(3), 50)
    return
  }
  if (text.includes('login')) {
    out({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, error: 'authentication_failed', session_id: sessionId })
    result({ is_error: true, terminal_reason: 'api_error', duration_ms: 30 })
    return
  }
  if (text.includes('secret')) {
    assistant([{ type: 'text', text: '키는 sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE0123456789 이에요' }])
    result()
    return
  }
  if (text.includes('slow')) {
    assistant([{ type: 'text', text: '오래 걸리는 일을 시작해요' }])
    interruptWanted = () => {
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', duration_ms: 900, session_id: sessionId })
    }
    return
  }
  if (text.includes('permdie')) {
    ask({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch die.txt' }, description: 'die.txt 만들기' }, () => {})
    setTimeout(() => process.exit(1), 300)
    return
  }
  if (text.includes('perm')) {
    const cmd = text.includes('danger') ? 'rm -rf build' : 'touch made.txt'
    assistant([{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: cmd } }])
    ask({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: cmd }, description: '파일 만들기' }, (resp) => {
      if (resp.behavior === 'allow') {
        out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'made', is_error: false }] } })
        assistant([{ type: 'text', text: `허락 받음 · ${resp.updatedInput?.command}` }])
      } else {
        out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: resp.message, is_error: true }] } })
        assistant([{ type: 'text', text: `거절됨 · ${resp.message}` }])
      }
      result()
    })
    return
  }
  if (text.includes('multi')) {
    ask(
      {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions: [{ question: '무엇을 넣을까요?', header: '넣기', multiSelect: true, options: [{ label: '시험', description: '' }, { label: '문서', description: '' }, { label: '린트', description: '' }] }] },
        requires_user_interaction: true,
      },
      (resp) => {
        assistant([{ type: 'text', text: `고른 것: ${resp.updatedInput?.answers?.['무엇을 넣을까요?']}` }])
        result()
      },
    )
    return
  }
  if (text.includes('ask')) {
    ask(
      {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions: [{ question: '어느 색이 좋아요?', header: '색', multiSelect: false, options: [{ label: '빨강', description: '따뜻한' }, { label: '파랑', description: '차가운' }, { label: '초록', description: '' }] }] },
        requires_user_interaction: true,
      },
      (resp) => {
        assistant([{ type: 'text', text: `고른 색: ${resp.updatedInput?.answers?.['어느 색이 좋아요?']}` }])
        result()
      },
    )
    return
  }
  assistant([{ type: 'tool_use', id: `tu-r${++seq}`, name: 'Read', input: { file_path: `${process.cwd()}/a.ts` } }])
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-r${seq}`, content: 'export const a = 1', is_error: false }] } })
  assistant([{ type: 'text', text: `echo: ${text}${images ? ` · 그림 ${images}` : ''}` }])
  result()
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  log({ stdin: o })
  if (o.type === 'user') {
    const content = o.message?.content ?? []
    const text = content.map((c) => c.text ?? '').join('')
    turn(text, content.filter((c) => c.type === 'image').length)
  } else if (o.type === 'control_response') {
    const then = waiting.get(o.response?.request_id)
    waiting.delete(o.response?.request_id)
    then?.(o.response?.response ?? {})
  } else if (o.type === 'control_request') {
    if (o.request?.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } })
      interruptWanted?.()
      interruptWanted = null
    } else if (o.request?.subtype === 'set_permission_mode') {
      mode = o.request.mode
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { mode } } })
    }
  }
})
rl.on('close', () => process.exit(0))
