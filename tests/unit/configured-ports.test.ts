import { createServer } from 'node:net'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { probeConfiguredPorts } from '../../src/main/port-probe'

it.skipIf(process.platform !== 'darwin')('finds an explicit TCP listener without using a terminal PID', async () => {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('address')
    const port = address.port
    expect(await probeConfiguredPorts([port])).toEqual([{ port, state: 'listening' }])
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
