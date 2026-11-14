import { afterEach, expect, test, vi } from 'vitest'
import { remoteEndpoint, RemoteClients } from '../../src/main/remote/client'
afterEach(()=>vi.unstubAllGlobals())
test('remote endpoint permits TLS or loopback tunnels and rejects token redirect surfaces', () => {
  expect(remoteEndpoint('https://example.invalid/')).toBe('https://example.invalid')
  expect(remoteEndpoint('http://127.0.0.1:4788')).toBe('http://127.0.0.1:4788')
  for (const url of ['http://example.invalid','https://user:pass@example.invalid','https://example.invalid/x','https://example.invalid/?token=x','file:///etc/passwd']) expect(() => remoteEndpoint(url)).toThrow()
})
test('malformed server data is rejected before poll results can poison renderer state',async()=>{
  const request=vi.fn(async()=>new Response(JSON.stringify({data:null})))
  vi.stubGlobal('fetch',request)
  const clients=new RemoteClients()
  await expect(clients.connect('http://127.0.0.1:4788','token')).rejects.toThrow('응답 형식')
  request.mockImplementation(async()=>new Response(JSON.stringify({data:[]})))
  const c=await clients.connect('http://127.0.0.1:4788','token')
  request.mockImplementation(async()=>new Response(JSON.stringify({data:{events:null,upTo:0}})))
  await expect(clients.call(c.id,'history',['workspace','chat'])).rejects.toThrow('응답 형식')
  request.mockImplementation(async()=>new Response(JSON.stringify({data:{events:[{t:'question',id:'request',questions:[{}]}],upTo:1}})))
  await expect(clients.call(c.id,'history',['workspace','chat'])).rejects.toThrow('응답 형식')
})
