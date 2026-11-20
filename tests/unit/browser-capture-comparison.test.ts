import { expect, it } from 'vitest'
import { compareCaptureConditions, keepCapture, type CaptureConditions } from '../../src/shared/browser-capture-comparison'

const base: CaptureConditions = { url: 'http://localhost:3000/example', viewport: '800 × 600', theme: 'dark', head: 'a'.repeat(40), zoom: '100%' }

it('identifies equal measured capture conditions', () => {
  expect(compareCaptureConditions(base, { ...base }).map(row => row.state)).toEqual(Array(5).fill('same'))
})
it('separates unknown conditions from observed differences', () => {
  const rows = compareCaptureConditions(base, { ...base, url: 'http://localhost:3000/extra', viewport: '900 × 600', theme: 'light', head: null })
  expect(rows.map(row => [row.field, row.state])).toEqual([
    ['url', 'different'], ['viewport', 'different'], ['theme', 'different'], ['head', 'unknown'], ['zoom', 'same'],
  ])
  expect(compareCaptureConditions({ ...base, head: null }, { ...base, head: null }).find(row => row.field === 'head')?.state).toBe('unknown')
})

it('retakes one capture without modifying or clearing the other', () => {
  const previous = { dataUrl: 'data:image/png;base64,AAAA', conditions: base }
  const next = { ...previous, dataUrl: 'data:image/png;base64,AAAB' }
  const captures = { before: previous, after: previous }
  expect(keepCapture(captures, 'after', next)).toEqual({ before: previous, after: next })
  expect(captures.after).toBe(previous)
  expect(() => keepCapture(captures, 'before', { ...next, dataUrl: 'data:text/html,preview' })).toThrow()
})
