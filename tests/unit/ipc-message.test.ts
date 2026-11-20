import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { ipcMessage } from '../../src/renderer/ipc-message'

// main 이 던진 오류는 renderer 에 'Error invoking remote method <채널>: Error: <원래 글>' 로 온다.
// 이 머리를 걷는 정규식이 renderer 6곳에 복사돼 있던 것을 ipcMessage 하나로 모았다.
describe('ipcMessage', () => {
  test('Electron 머리와 Error: 를 걷는다', () => {
    expect(ipcMessage(new Error("Error invoking remote method 'backup:mark': Error: 디스크가 꽉 찼어요"), '기본')).toBe('디스크가 꽉 찼어요')
  })
  test('머리 뒤에 Error: 가 없으면 머리만 걷는다 — 다른 오류 이름(TypeError:)은 남긴다', () => {
    expect(ipcMessage(new Error("Error invoking remote method 'x': 권한이 없어요"), '기본')).toBe('권한이 없어요')
    expect(ipcMessage(new Error("Error invoking remote method 'x': TypeError: y is undefined"), '기본')).toBe('TypeError: y is undefined')
  })
  test('머리가 없으면 글 그대로 — 글 가운데의 머리는 걷지 않는다', () => {
    expect(ipcMessage(new Error('Error: 그대로'), '기본')).toBe('Error: 그대로')
    expect(ipcMessage(new Error("앞 Error invoking remote method 'x': Error: 뒤"), '기본')).toBe("앞 Error invoking remote method 'x': Error: 뒤")
  })
  test('빈 message 는 fallback, keepEmpty 면 빈 글 그대로(App · 백업 · 워크트리 화면의 옛 동작)', () => {
    expect(ipcMessage(new Error(''), '기본')).toBe('기본')
    expect(ipcMessage(new Error(''), '기본', { keepEmpty: true })).toBe('')
  })
  test('머리만 있는 message 는 걷은 뒤 빈 글 — 비었는지는 걷기 전에 본다(가져오기 · 세션 띠의 옛 동작)', () => {
    expect(ipcMessage(new Error("Error invoking remote method 'x': Error: "), '기본')).toBe('')
  })
  test('Error 가 아니면 fallback', () => {
    expect(ipcMessage('문자열', '기본')).toBe('기본')
    expect(ipcMessage(undefined, '기본')).toBe('기본')
    expect(ipcMessage({ message: "Error invoking remote method 'x': Error: 가짜" }, '기본', { keepEmpty: true })).toBe('기본')
  })
})

// 재발 막기: 머리 글자를 손으로 걷는 곳이 다시 생기지 않게 — renderer 에서 그 글자는 ipc-message.ts 에만 있다
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })

test('renderer 에서 IPC 오류 머리 글자는 ipc-message.ts 에만 있다 (손으로 쓴 걷기 없음)', () => {
  const found = sources(fileURLToPath(new URL('../../src/renderer', import.meta.url))) // cwd 와 무관하게
    .filter((file) => !file.endsWith(join('renderer', 'ipc-message.ts')))
    .flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (line.includes('Error invoking remote method') ? [`${relative('.', file)}:${i + 1}`] : [])),
    )
  expect(found).toEqual([])
})
