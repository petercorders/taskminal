import { beforeEach, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: (...args: unknown[]) => {
    if (args[0] === '/usr/sbin/lsof' && typeof args.at(-1) === 'function') return probe.exec(...args)
    return Reflect.apply(actual.execFile, null, args)
  } }
})
import { strictLsofCwds } from '../../src/main/cwd-probe'

const exec = probe.exec
beforeEach(() => { exec.mockReset() })

it.each([
  new Error('timeout'), new Error('stdout maxBuffer exceeded'), new Error('exit 1'),
])('rejects any process error despite a plausible complete stdout: %s', async error => {
  exec.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(error, 'p101\0\nfcwd\0n/tmp\0\n', '')
  })
  await expect(strictLsofCwds([101])).rejects.toThrow()
})

it('rejects warnings and runs with explicit framing, deadline, output bound and UTF-8 locale', async () => {
  exec.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, 'p101\0\nfcwd\0n/tmp\0\n', 'warning: incomplete data')
  })
  await expect(strictLsofCwds([101])).rejects.toThrow()
  expect(exec).toHaveBeenCalledWith('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-F0pn', '-p', '101'], expect.objectContaining({
    timeout: 2000, maxBuffer: expect.any(Number), env: expect.objectContaining({ LC_ALL: 'en_US.UTF-8' }),
  }), expect.any(Function))
})
