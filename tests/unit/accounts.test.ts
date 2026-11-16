import { expect, test } from 'vitest'
import { codexUsage } from '../../src/shared/accounts'
test('real zero stays zero, missing usage is empty, seconds become milliseconds', () => {
  expect(codexUsage({ rateLimits: { primary: { usedPercent: 0, resetsAt: 1800000000, windowDurationMins: 300 } } })).toEqual([
    { label: 'Codex · 300분', used: 0, resetsAt: 1800000000000 },
  ])
  expect(codexUsage({ rateLimits: null })).toEqual([])
  expect(codexUsage({ rateLimits: { primary: { usedPercent: Infinity } } })).toEqual([])
  expect(codexUsage({ rateLimits: { primary: { usedPercent: -1 } } })).toEqual([])
})
test('multiple buckets override aggregate and malformed windows cannot escape', () => {
  expect(
    codexUsage({
      rateLimitsByLimitId: { a: { primary: { usedPercent: 80 } }, b: { secondary: { usedPercent: 40 } } },
      rateLimits: { primary: { usedPercent: 90 } },
    }).map((w) => w.used),
  ).toEqual([80, 40])
  expect(codexUsage(null)).toEqual([])
})
