import { expect, it, vi } from 'vitest'
import { GitWorkflowService } from '../../src/main/git-workflow'
import { dependencyOrder, parsePrLinks, type PrDependency } from '../../src/shared/pr-dependencies'

const server = 'https://github.com/example/server/pull/7'
const frontend = 'https://github.com/example/frontend/pull/9'
const client = 'https://github.com/example/client/pull/11'
const row = (url: string, state: PrDependency['state'] = 'merged', checks: PrDependency['checks'] = 'passed'): PrDependency =>
  ({ url, state, checks, title: '' })

it('accepts ordered cross-repository PR URLs and rejects unsafe or duplicate inputs', () => {
  expect(parsePrLinks([server, frontend]).map(row => row.repository)).toEqual(['example/server', 'example/frontend'])
  expect(() => parsePrLinks([server, server.toUpperCase()])).toThrow()
  expect(() => parsePrLinks([server, 'https://github.com.example.invalid/example/frontend/pull/9'])).toThrow()
  expect(() => parsePrLinks([server, frontend+'?token=extra'])).toThrow()
})

it('holds later steps when the first check is failed or unconfirmed', () => {
  for (const first of [row(server, 'unknown', 'none'), row(server, 'merged', 'failed'), row(server, 'merged', 'none'), row(server, 'open')]) {
    expect(dependencyOrder([first, row(frontend), row(client)]).map(result => result.blockedBy)).toEqual([null, server, server])
  }
  expect(dependencyOrder([row(server), row(frontend, 'open'), row(client)]).map(result => result.blockedBy)).toEqual([null, null, frontend])
})

it('reads each named repository and treats returned URL mismatches as unknown', async () => {
  const run = vi.fn(async (_tool: string, args: readonly string[]) => ({
    code: 0, timedOut: false, missing: false,
    stdout: JSON.stringify({
      number: Number(args[2]), title: 'change', url: server, state: 'MERGED',
      isCrossRepository: true, headRefOid: 'a'.repeat(40), headRefName: 'feature', baseRefName: 'main',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    }),
  }))
  const result = await new GitWorkflowService(run).dependencies('/tmp', [server, frontend])
  expect(result).toEqual([row(server, 'merged', 'passed'), row(frontend, 'unknown', 'none')].map((r, i) => i === 0 ? { ...r, title: 'change' } : r))
  expect(run.mock.calls.map(([, args]) => [args[2], args[4]])).toEqual([['7', 'example/server'], ['9', 'example/frontend']])
})

it('returns unknown when the GitHub read fails', async () => {
  const run = vi.fn(async () => ({ code: 1, timedOut: false, missing: false, stdout: '' }))
  expect(await new GitWorkflowService(run).dependencies('/tmp', [server])).toEqual([row(server, 'unknown', 'none')])
})
