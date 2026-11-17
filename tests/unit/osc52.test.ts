import { describe, expect, it } from 'vitest'
import { OSC52_MAX_BYTES, parseOsc52 } from '../../src/shared/osc52'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const MAX = OSC52_MAX_BYTES

describe('parseOsc52 — 터미널 안 프로그램의 복사 (58c)', () => {
  it('<선택>;<base64> 를 풀어 글로', () => {
    expect(parseOsc52(`c;${b64('hello')}`, MAX)).toBe('hello')
    expect(parseOsc52(`c;${b64('두 줄\n복사')}`, MAX)).toBe('두 줄\n복사')
  })

  it('한글 · 이모지도 UTF-8 로', () => {
    expect(parseOsc52(`c;${b64('한글 복사 ✓ 🙂')}`, MAX)).toBe('한글 복사 ✓ 🙂')
  })

  it('선택 칸: 빈 값 · c 를 포함하면 받고, 다른 것만(p · s · 0)이면 버린다', () => {
    expect(parseOsc52(`;${b64('a')}`, MAX)).toBe('a')
    expect(parseOsc52(`pc;${b64('a')}`, MAX)).toBe('a')
    expect(parseOsc52(`cs0;${b64('a')}`, MAX)).toBe('a')
    expect(parseOsc52(`p;${b64('a')}`, MAX)).toBeNull()
    expect(parseOsc52(`s;${b64('a')}`, MAX)).toBeNull()
    expect(parseOsc52(`s0;${b64('a')}`, MAX)).toBeNull()
  })

  it('읽기 요청(?)에는 답하지 않는다', () => {
    expect(parseOsc52('c;?', MAX)).toBeNull()
    expect(parseOsc52(';?', MAX)).toBeNull()
  })

  it('깨진 값은 버린다 — ; 없음 · base64 가 아닌 글자 · 있을 수 없는 길이 · 틀린 패딩 · UTF-8 이 아닌 바이트', () => {
    expect(parseOsc52('c', MAX)).toBeNull()
    expect(parseOsc52(b64('hello'), MAX)).toBeNull()
    expect(parseOsc52('c;aGVs bG8=', MAX)).toBeNull()
    expect(parseOsc52('c;aGVs-G8_', MAX)).toBeNull() // URL 용 base64
    expect(parseOsc52('c;aGVsb', MAX)).toBeNull() // 길이 % 4 = 1
    expect(parseOsc52('c;aGVsbG8==', MAX)).toBeNull()
    expect(parseOsc52('c;=aGVsbG8', MAX)).toBeNull()
    expect(parseOsc52(`c;${Buffer.from([0xff, 0xfe, 0x41]).toString('base64')}`, MAX)).toBeNull()
  })

  it('패딩이 빠진 base64 는 받는다', () => {
    expect(parseOsc52('c;aGVsbG8', MAX)).toBe('hello')
    expect(parseOsc52('c;aGk', MAX)).toBe('hi')
  })

  it('빈 내용은 버린다 — 프로그램이 클립보드를 비우지 못한다', () => {
    expect(parseOsc52('c;', MAX)).toBeNull()
    expect(parseOsc52(';', MAX)).toBeNull()
  })

  it('상한(바이트)까지만 — 넘으면 버린다', () => {
    expect(parseOsc52(`c;${b64('a'.repeat(10))}`, 10)).toBe('a'.repeat(10))
    expect(parseOsc52(`c;${b64('a'.repeat(11))}`, 10)).toBeNull()
    expect(parseOsc52(`c;${b64('한')}`, 2)).toBeNull() // 글자 수가 아니라 바이트(3)
    expect(parseOsc52(`c;${b64('한')}`, 3)).toBe('한')
    expect(MAX).toBe(100 * 1024)
    expect(parseOsc52(`c;${b64('x'.repeat(MAX))}`, MAX)).toHaveLength(MAX)
    expect(parseOsc52(`c;${b64('x'.repeat(MAX + 1))}`, MAX)).toBeNull()
  })
})
