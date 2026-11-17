/** 원격 터미널 입력 큐 (58단계) — 글자마다 요청 하나를 차례로 기다리던 것을, 보낼 때 쌓인 것을 묶어 한 번에 보낸다. */
export interface RemoteInput {
  requestId: string
  data: string
  /** 이미 보낸 묶음 — 결과를 모를 때 번호 · 글을 바꾸지 않고 그대로 다시 보낸다 */
  sent?: true
}

export function pushInput(queue: RemoteInput[], data: string, requestId: string): void {
  queue.push({ requestId, data })
}

/**
 * 다음에 보낼 묶음(큐 맨 앞에 놓인다). 맨 앞이 이미 보낸 것이면 그대로 돌려준다.
 * 아니면 안 보낸 것들을 앞에서부터 max 글자까지 하나로 묶고(번호는 첫 것) 보낸 것으로 표시한다.
 * 혼자 max 를 넘는 입력(큰 붙여넣기)은 나누지 않고 그대로 하나다.
 */
export function takeInput(queue: RemoteInput[], max: number): RemoteInput | undefined {
  const head = queue[0]
  if (!head || head.sent) return head
  let count = 1
  let data = head.data
  while (count < queue.length && data.length + queue[count]!.data.length <= max) data += queue[count++]!.data
  const batch: RemoteInput = { requestId: head.requestId, data, sent: true }
  queue.splice(0, count, batch)
  return batch
}
