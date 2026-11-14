import { randomUUID } from 'node:crypto'
import type { RemoteConnection } from '../../shared/remote-workspace'
import { validRemoteResult } from '../../shared/remote-validation'

export function remoteEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw Error('서버 주소를 확인해 주세요')
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw Error('서버 기본 주소만 입력해 주세요')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw Error('HTTPS 주소 또는 SSH 터널의 loopback 주소가 필요합니다')
  return url.origin
}
/** Main-process memory only: tokens never enter renderer state or persistent app journals. */
export class RemoteClients {
  private readonly connections = new Map<string, {url: string; token: string}>()
  async connect(value: unknown, secret: unknown): Promise<RemoteConnection> {
    const url = remoteEndpoint(value)
    if (typeof secret !== 'string' || !secret.trim() || secret.length > 4096 || /[\r\n]/.test(secret)) throw Error('접속 토큰을 확인해 주세요')
    const id = randomUUID(); this.connections.set(id, {url, token: secret.trim()})
    try { await this.call(id, 'workspaces', []); return {id, url} } catch (e) { this.connections.delete(id); throw e }
  }
  disconnect(id: unknown) { if (typeof id !== 'string') throw Error('연결 번호'); this.connections.delete(id) }
  async call(id: unknown, method: string, args: unknown[]): Promise<unknown> {
    const c = typeof id === 'string' ? this.connections.get(id) : undefined
    if (!c) throw Error('서버에 다시 연결해 주세요')
    let response: Response
    try { response = await fetch(c.url + '/rpc', {method: 'POST', headers: {Authorization: 'Bearer ' + c.token, 'Content-Type':'application/json'}, redirect: 'error', body: JSON.stringify({method,args}), signal: AbortSignal.timeout(20000)}) }
    catch { throw Error('서버 응답을 확인하지 못했어요. 다시 연결해 출력·파일·기록을 확인해 주세요') }
    const reader = response.body?.getReader(); if (!reader) throw Error('서버 응답 형식')
    const chunks: Uint8Array[] = []; let size = 0
    try { for (;;) { const {done,value} = await reader.read(); if(done) break; size += value.length; if(size > 8_000_000) throw Error('서버 응답 크기 한도'); chunks.push(value) } }
    catch(e) { await reader.cancel().catch(() => {}); throw e }
    let payload: {data?: unknown; error?: unknown}
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Error('서버 응답 형식') }
    if (!response.ok || typeof payload.error === 'string') throw Error(typeof payload.error === 'string' ? payload.error.slice(0,500) : '서버 요청이 거절됐어요')
    if (!validRemoteResult(method,payload.data)) throw Error('서버 응답 형식이 맞지 않아요. 서버 버전을 확인해 주세요')
    return payload.data
  }
  clear() { this.connections.clear() }
}
