import { isChatEvent } from './chat'
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max=4096): v is string => typeof v === 'string' && v.length <= max
const id = (v: unknown) => str(v,100) && /^[\w-]{1,100}$/.test(v)
const terminal = (v: unknown) => obj(v) && id(v.id) && str(v.title) && (v.exited === undefined || Number.isSafeInteger(v.exited))
const chat = (v: unknown) => obj(v) && id(v.id) && ['claude','codex'].includes(v.agent as string)
const workspace = (v: unknown) => obj(v) && id(v.id) && str(v.name) && str(v.path) && Array.isArray(v.sessions) && v.sessions.length<=200 && v.sessions.every(terminal) && Array.isArray(v.chats) && v.chats.length<=200 && v.chats.every(chat)
const file = (v: unknown) => obj(v) && str(v.path) && str(v.signature,64) && /^[a-f0-9]{64}$/.test(v.signature) && str(v.text,2_000_000)
const event = (v: unknown) => {
  if(!isChatEvent(v)) return false
  if(v.t === 'question') return v.questions.length<=20 && v.questions.every(q=>obj(q) && str(q.question,20000) && str(q.header) && typeof q.multi==='boolean' && Array.isArray(q.options) && q.options.length<=100 && q.options.every(o=>obj(o) && str(o.label,2000) && str(o.description,20000)))
  if(v.t === 'permission') return str(v.tool) && str(v.summary,100000) && str(v.why,100000) && typeof v.danger==='boolean'
  return true
}
/** Remote servers can be older or malformed. Never pass unchecked structures into renderer state. */
export function validRemoteResult(method: string, v: unknown): boolean {
  switch(method) {
    case 'workspaces': return Array.isArray(v) && v.length<=50 && v.every(workspace)
    case 'open': return workspace(v)
    case 'files': return Array.isArray(v) && v.length<=1000 && v.every(e=>obj(e) && str(e.name) && str(e.path) && typeof e.directory==='boolean')
    case 'read': return file(v)
    case 'save': return obj(v) && (v.ok===true ? file(v.file) : v.ok===false && v.reason==='conflict' && file(v.current))
    case 'git': return obj(v) && str(v.status,2_000_000) && str(v.diff,2_000_000) && str(v.branch)
    case 'terminal': return terminal(v)
    case 'tail': return obj(v) && str(v.data,1_000_000) && (v.exited===undefined || Number.isSafeInteger(v.exited))
    case 'chat': return chat(v)
    case 'history': return obj(v) && Array.isArray(v.events) && v.events.length<=50000 && v.events.every(event) && Number.isSafeInteger(v.upTo) && (v.upTo as number)>=0
    case 'answer': return typeof v==='boolean'
    case 'write': case 'stop': case 'send': case 'interrupt': return v===null
    default: return false
  }
}
