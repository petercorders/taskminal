import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChatStore } from '../../src/main/chat/chat-store'

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'

describe('ChatStore', () => {
  it('가린 이벤트만 0600 파일에, 다시 읽으면 같은 순서', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'chat-')), 'chat')
    const s = new ChatStore(dir)
    await s.append('p1', [{ t: 'user', text: `키는 ${KEY}`, at: 1 }, { t: 'text', text: '네' }])
    const raw = readFileSync(join(dir, 'p1.jsonl'), 'utf8')
    expect(raw).not.toContain(KEY)
    expect(statSync(join(dir, 'p1.jsonl')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const back = await s.read('p1')
    expect(back.map((e) => e.t)).toEqual(['user', 'text'])
    expect(await s.read('nope')).toEqual([])
  })
  it('깨진 줄 · 모양이 틀린 줄은 버린다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-'))
    writeFileSync(join(dir, 'p1.jsonl'), '{"t":"text","text":"a"}\n{깨짐\n{"t":"text"}\n{"t":"zzz"}\n')
    expect(await new ChatStore(dir).read('p1')).toEqual([{ t: 'text', text: 'a' }])
  })
  it('상한을 넘으면 앞을 잘라 뒤 절반만 남긴다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-'))
    const s = new ChatStore(dir, () => ({}), 1000)
    for (let i = 0; i < 40; i++) await s.append('p1', [{ t: 'text', text: `줄 ${i} ` + 'x'.repeat(20) }])
    const back = await s.read('p1')
    expect(statSync(join(dir, 'p1.jsonl')).size).toBeLessThanOrEqual(1000)
    expect(back.at(-1)).toEqual({ t: 'text', text: '줄 39 ' + 'x'.repeat(20) })
    expect(back.length).toBeLessThan(40)
  })
  it('지우기', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-'))
    appendFileSync(join(dir, 'p1.jsonl'), '{"t":"stopped"}\n')
    const s = new ChatStore(dir)
    await s.remove('p1')
    await s.remove('p1')
    expect(await s.read('p1')).toEqual([])
  })
  it('되감기 replace: 앞 n 개만 남기고 0600 · 가린 글로', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-'))
    const s = new ChatStore(dir)
    await s.append('p1', [{ t: 'user', text: '하나', at: 1 }, { t: 'text', text: '답' }, { t: 'user', text: '둘', at: 2 }])
    await s.replace('p1', [{ t: 'user', text: `하나 ${KEY}`, at: 1 }])
    expect(await s.read('p1')).toEqual([{ t: 'user', text: expect.stringContaining('하나'), at: 1 }])
    expect(readFileSync(join(dir, 'p1.jsonl'), 'utf8')).not.toContain(KEY)
    expect(statSync(join(dir, 'p1.jsonl')).mode & 0o777).toBe(0o600)
  })
  it('그림 파일: <pane>.img/ 에 0600 · 내용 그대로 · remove 가 함께 지움', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-'))
    const s = new ChatStore(dir)
    const f = await s.saveImage('p1', { name: 'a.png', mime: 'image/png', data: Buffer.from('PNGDATA').toString('base64') }, 1)
    expect(f.startsWith(join(dir, 'p1.img') + '/')).toBe(true)
    expect(f.endsWith('.png')).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('PNGDATA')
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'p1.img')).mode & 0o777).toBe(0o700)
    await s.remove('p1')
    expect(existsSync(join(dir, 'p1.img'))).toBe(false)
  })
})
