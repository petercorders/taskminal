export interface CaptureConditions {
  url: string
  viewport: string | null
  theme: 'light' | 'dark' | null
  head: string | null
  zoom: string | null
}
export interface CaptureForComparison { dataUrl: string; conditions: CaptureConditions }

const fields = ['url', 'viewport', 'theme', 'head', 'zoom'] as const
export function compareCaptureConditions(before: CaptureConditions, after: CaptureConditions) {
  return fields.map(field => {
    const left = before[field], right = after[field]
    return { field, left, right, state: !left || !right ? 'unknown' : left === right ? 'same' : 'different' } as const
  })
}

export function keepCapture(
  captures: Partial<Record<'before' | 'after', CaptureForComparison>>,
  slot: 'before' | 'after',
  next: CaptureForComparison,
): Partial<Record<'before' | 'after', CaptureForComparison>> {
  if (!next.dataUrl.startsWith('data:image/png;base64,') || next.dataUrl.length > 12 * 1024 * 1024) throw new Error('비교에 보관할 수 있는 PNG 크기를 넘었어요.')
  return { ...captures, [slot]: next }
}
