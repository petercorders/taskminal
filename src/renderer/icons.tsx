// 28단계: 이모지 대신 쓰는 선 아이콘 — 16px 상자 · 1.5 선 · 글자색을 따른다(Orca 처럼 한 가지 모양). 직접 그린 단순한 도형이다.
const PATHS = {
  sliders: 'M3 4h6M12 4h1M3 8h2M8 8h5M3 12h7M13 12h0M10.5 2.5v3M6.5 6.5v3M11.5 10.5v3',
  palette: 'M8 2.5a5.5 5.5 0 1 0 0 11c.9 0 1.2-.7.8-1.4-.5-.8.1-1.6 1-1.6H11a2.5 2.5 0 0 0 2.5-2.5C13.5 4.8 11 2.5 8 2.5Z',
  terminal: 'M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5',
  shield: 'M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z',
  bell: 'M4.5 11V7.5a3.5 3.5 0 0 1 7 0V11l1 1.5h-9zM6.8 13.8a1.3 1.3 0 0 0 2.4 0',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2',
  restore: 'M3 8a5 5 0 1 0 1.5-3.5M3 2.5v2.8h2.8M8 5.5V8l1.8 1.2',
  keyboard: 'M2 4.5h12v7H2zM4.5 7h0M7 7h0M9.5 7h0M12 7h0M5 9.5h6',
  list: 'M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h0M2.5 8h0M2.5 11.5h0',
  info: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 7.5v3.5M8 5.2h0',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6l3 3',
  back: 'M13 8H3.5M7.5 4 3.5 8l4 4',
  close: 'M4 4l8 8M12 4l-8 8',
  chart: 'M2.5 13.5h11M4.5 11V7.5M8 11V4M11.5 11V9',
  archive: 'M2.5 3.5h11v3h-11zM3.5 6.5v6.5h9V6.5M6.5 9h3',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.8h2.8M8 5v3.2l2 1.3',
  note: 'M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3M5.5 8.5h5M5.5 11h3.5',
  clip: 'M10.5 5 6 9.5a1.4 1.4 0 0 0 2 2l4.6-4.6a2.8 2.8 0 0 0-4-4L4 7.5a4.2 4.2 0 0 0 6 6l3.5-3.5',
  gear: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  bolt: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10 6h0',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  )
}
