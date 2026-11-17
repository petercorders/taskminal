import { expect, test } from 'vitest'
import { pushInput, takeInput, type RemoteInput } from '../../src/shared/remote-input'

// 58단계: 원격 터미널이 글자마다 요청 하나를 차례로 기다렸다(지연 150ms 에 57글자 → 쓰기 67번 · 12초).
test('쌓인 입력은 순서 그대로 요청 하나로 묶인다 — 번호는 첫 것', () => {
  const queue: RemoteInput[] = []
  pushInput(queue, 'l', 'id-1'); pushInput(queue, 's', 'id-2'); pushInput(queue, '\r', 'id-3')
  expect(takeInput(queue, 1000)).toEqual({ requestId: 'id-1', data: 'ls\r', sent: true })
  expect(queue).toHaveLength(1)
})

test('이미 보낸 묶음은 다시 꺼내도 번호와 글이 그대로다 — 결과를 모를 때 같은 요청으로 다시 보낸다', () => {
  const queue: RemoteInput[] = []
  pushInput(queue, 'a', 'id-1'); pushInput(queue, 'b', 'id-2')
  const first = takeInput(queue, 1000)
  pushInput(queue, 'c', 'id-3') // 보내는 중에 친 글자
  expect(takeInput(queue, 1000)).toBe(first)
  expect(first).toEqual({ requestId: 'id-1', data: 'ab', sent: true })
  expect(queue.map((item) => item.data)).toEqual(['ab', 'c'])
})

test('보내는 중에 친 글자는 앞 요청이 끝난 뒤 다음 묶음으로 간다', () => {
  const queue: RemoteInput[] = []
  pushInput(queue, 'a', 'id-1')
  takeInput(queue, 1000)
  pushInput(queue, 'b', 'id-2'); pushInput(queue, 'c', 'id-3')
  queue.shift() // 앞 요청 성공
  expect(takeInput(queue, 1000)).toEqual({ requestId: 'id-2', data: 'bc', sent: true })
})

test('한 묶음은 상한 글자까지 — 넘는 것은 다음 묶음, 혼자 상한을 넘는 붙여넣기는 그대로 하나', () => {
  const queue: RemoteInput[] = []
  pushInput(queue, 'aaa', 'id-1'); pushInput(queue, 'bbb', 'id-2'); pushInput(queue, 'c', 'id-3')
  expect(takeInput(queue, 5)?.data).toBe('aaa')
  queue.shift()
  expect(takeInput(queue, 5)?.data).toBe('bbbc')
  queue.shift()
  pushInput(queue, 'x'.repeat(9), 'id-4'); pushInput(queue, 'y', 'id-5')
  expect(takeInput(queue, 5)?.data).toBe('x'.repeat(9))
})

test('빈 큐에서는 보낼 것이 없다', () => {
  expect(takeInput([], 1000)).toBeUndefined()
})
