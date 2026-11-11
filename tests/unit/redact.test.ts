import { describe, expect, it } from 'vitest'
import { customPatternError, findSecrets, maskOf, redact, secretHash, type SecretToggleId } from '../../src/shared/redact'

const ANT = 'sk-ant-api03-' + 'Zk8aB_c-d'.repeat(8)
const OPENAI = 'sk-proj-' + 'A1b2C3d4'.repeat(6)
const GHP = 'ghp_' + 'a1B2c3D4e5'.repeat(4)
const PAT = 'github_pat_' + '11ABCDEFG0'.repeat(7)
const AWS = 'AKIAIOSFODNN7EXAMPLE'
const SLACK = 'xoxb-1234567890-abcdefghij'
const ATL = 'ATATT3xFfGF0' + 'Ab12_-='.repeat(4)
const NOTION = 'ntn_' + 'x9Y8z7'.repeat(6)
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----'

describe('redact — 종류마다 맞는 예', () => {
  it.each([
    [ANT, 'Anthropic 키'],
    [OPENAI, 'OpenAI 키'],
    [GHP, 'GitHub 토큰'],
    [PAT, 'GitHub 토큰'],
    [AWS, 'AWS 접근 키'],
    [SLACK, 'Slack 토큰'],
    [ATL, 'Atlassian 토큰'],
    [NOTION, 'Notion 토큰'],
    [JWT, 'JWT'],
    [KEY, '개인 키'],
  ])('%s → %s', (value, kind) => {
    const out = redact(`앞 ${value} 뒤`)
    expect(out).toBe(`앞 ${maskOf(kind)} 뒤`)
    expect(out).not.toContain(value)
  })

  it('Bearer 뒤의 토큰 (JWT 가 아닌 것)', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe('Authorization: Bearer ‹가림:Bearer 토큰›')
  })

  it('이름 붙은 값 — 따옴표 · 콜론 · 소문자', () => {
    expect(redact('DB_PASSWORD=Qx7!pL2m9zR')).toBe('DB_PASSWORD=‹가림:비밀번호›')
    expect(redact('password: "hunter2 long"')).toBe('password: "‹가림:비밀번호›"')
    expect(redact("api_key='abcd1234'")).toBe("api_key='‹가림:비밀번호›'")
    expect(redact('client_secret = s3cr3tvalue,next')).toBe('client_secret = ‹가림:비밀번호›,next')
  })

  it('겹치면 구체적인 종류가 이긴다 (GITHUB_TOKEN=ghp_…)', () => {
    expect(redact(`GITHUB_TOKEN=${GHP}`)).toBe('GITHUB_TOKEN=‹가림:GitHub 토큰›')
    expect(redact(`ANTHROPIC_API_KEY=${ANT}`)).toBe('ANTHROPIC_API_KEY=‹가림:Anthropic 키›')
  })

  it('길이를 남기지 않는다 — 짧은 값과 긴 값이 같은 모양', () => {
    expect(redact('PASSWORD=abcd')).toBe(redact('PASSWORD=' + 'z'.repeat(80)))
  })

  it('한 줄에 여러 개', () => {
    const out = redact(`a=${AWS} b=${SLACK}`)
    expect(out).toBe('a=‹가림:AWS 접근 키› b=‹가림:Slack 토큰›')
  })
})

describe('redact — 비슷하지만 아닌 예', () => {
  it.each([
    ['커밋 해시', 'commit 9f8e7d6a5b4c3d2e1f0a9f8e7d6a5b4c3d2e1f0a'],
    ['UUID', 'pane 7f3a2b1c-4d5e-4f60-8a9b-0c1d2e3f4a5b'],
    ['base64 이미지', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='],
    ['짧은 sk-', 'sk-ant-short'],
    ['변수 참조', 'export TOKEN=$GITHUB_TOKEN'],
    ['중괄호 변수', 'SECRET=${MY_SECRET}'],
    ['별표', 'PASSWORD=********'],
    ['AKIA 가 긴 낱말 속', 'XAKIAIOSFODNN7EXAMPLEZ'],
    ['이미 가린 것', 'PASSWORD=‹가림:비밀번호›'],
    ['평범한 로그', 'BUILD SUCCESSFUL in 12s — tokens: 1234'],
    ['eyJ 하나뿐', 'eyJhbGciOiJIUzI1NiJ9 only'],
  ])('%s', (_, text) => {
    expect(redact(text)).toBe(text)
  })
})

describe('redact — 색 코드', () => {
  it('토큰 중간의 색 코드(grep --color) — 가린 뒤 색 코드는 남긴다', () => {
    const tail = '-api03-' + 'c'.repeat(40)
    const text = `X=\x1b[01;31msk-ant\x1b[m${tail} 끝`
    const out = redact(text)
    expect(out).not.toContain('sk-ant')
    expect(out).not.toContain(tail)
    expect(out).toBe('X=\x1b[01;31m‹가림:Anthropic 키›\x1b[m 끝')
  })
  it('토큰 앞뒤의 색 코드는 그대로', () => {
    expect(redact(`\x1b[32mKEY=${ANT}\x1b[0m done`)).toBe('\x1b[32mKEY=‹가림:Anthropic 키›\x1b[0m done')
  })
  it('색 코드만 있고 비밀값이 없으면 원문 그대로(같은 객체)', () => {
    const t = '\x1b[1mbold\x1b[0m'
    expect(redact(t)).toBe(t)
  })
})

describe('옵션', () => {
  it('가리지 않기로 한 값은 그 값만 건너뛴다', () => {
    const allow = new Set([secretHash('Qx7!pL2m9zR')])
    expect(redact('A_PASSWORD=Qx7!pL2m9zR B_PASSWORD=other123', { allow })).toBe('A_PASSWORD=Qx7!pL2m9zR B_PASSWORD=‹가림:비밀번호›')
  })
  it('내 종류', () => {
    expect(redact('id acme_abcdefgh1234', { custom: [{ name: 'ACME 키', pattern: 'acme_[a-z0-9]{12}' }] })).toBe('id ‹가림:ACME 키›')
  })
  it('모양이 틀린 내 종류는 무시(던지지 않음)', () => {
    expect(redact('acme_x', { custom: [{ name: 'x', pattern: 'acme_[' }] })).toBe('acme_x')
  })
  it('화면: 켠 종류만', () => {
    const toggles = new Set<SecretToggleId>(['anthropic'])
    const found = findSecrets(`${ANT} PASSWORD=abcd1234`, { toggles })
    expect(found.map((f) => f.kind)).toEqual(['Anthropic 키'])
  })
  it('찾은 자리 · 값', () => {
    const [f] = findSecrets(`x ${AWS}`)
    expect(f).toEqual({ start: 2, end: 2 + AWS.length, kind: 'AWS 접근 키', value: AWS })
  })
  it('해시는 같은 값에 같고 다른 값에 다르다', () => {
    expect(secretHash('abc')).toBe(secretHash('abc'))
    expect(secretHash('abc')).not.toBe(secretHash('abd'))
  })
})

describe('customPatternError', () => {
  it('맞는 모양', () => expect(customPatternError('acme_[A-Za-z0-9]{32}')).toBeNull())
  it('닫히지 않은 모양', () => expect(customPatternError('acme_[A-Za-z0-9]{32')).toBe('이 모양은 읽을 수 없어요: 닫는 } 가 없어요'))
  it('닫히지 않은 [', () => expect(customPatternError('acme_[a-z')).toBe('이 모양은 읽을 수 없어요: 닫는 ] 가 없어요'))
  it('빈 글에 맞는 모양', () => expect(customPatternError('a*')).toMatch(/빈 글/))
  it('빈 칸', () => expect(customPatternError('  ')).toMatch(/적어/))
})
