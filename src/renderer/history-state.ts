// 명령 기록의 renderer 쪽 (19단계): 메모리 목록 · main 으로 보내는 대기열 · 지운 표시.
// 목록은 앱이 처음 읽힐 때 한 번 읽고(그 뒤는 메모리가 기준 — 이 앱 말고 쓰는 곳이 없다), 그 사이 끝난 명령과 id 로 합친다.
import { useEffect, useRef, useState } from 'react'
import { mergeEntries, type HistoryEntry } from '../shared/history'

/** 한 번에 보내는 줄 (main 의 APPEND_MAX 와 같다) */
const SEND_MAX = 50
/** 보내지 못해 쌓아 두는 줄 — 넘치면 오래된 것부터 버린다 */
export const QUEUE_MAX = 500

export interface HistoryView {
  /** 지운 표시가 없는 기록 (오래된 → 최근) */
  entries: readonly HistoryEntry[]
  /** 지난 실행에서 읽은 기록 id — '이전 세션' */
  prevIds: ReadonlySet<string>
  /** 저장 실패 — 칸 머리 줄 */
  saveFailed: boolean
  add(entry: HistoryEntry): void
  retry(): void
  /** 화면에서만 숨긴다 — 되돌리기를 기다리는 동안 */
  hide(ids: readonly string[]): void
  unhide(ids: readonly string[]): void
  /** 숨긴 것을 파일 · 메모리에서 지운다 (토스트가 끝난 뒤) */
  drop(taskId: string, ids: readonly string[]): void
  dropTask(taskId: string): void
  clearAll(): Promise<void>
}

export function useHistory(ready: boolean): HistoryView {
  const [all, setAll] = useState<readonly HistoryEntry[]>([])
  const [prevIds, setPrevIds] = useState<ReadonlySet<string>>(() => new Set())
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const [saveFailed, setSaveFailed] = useState(false)
  const queue = useRef<HistoryEntry[]>([])
  const sending = useRef(false)

  // 보내기는 한 번에 하나 — 실패하면 대기열에 그대로 두고 다음 기록 · [다시 저장] 때 앞에서부터 (같은 id 는 main 이 거른다)
  const flush = () => {
    if (sending.current || queue.current.length === 0) return
    sending.current = true
    const batch = queue.current.slice(0, SEND_MAX)
    window.taskminal.history.append(batch).then(
      () => {
        const sent = new Set(batch.map((e) => e.id))
        queue.current = queue.current.filter((e) => !sent.has(e.id))
        sending.current = false
        if (queue.current.length === 0) setSaveFailed(false)
        flush()
      },
      () => {
        sending.current = false
        setSaveFailed(true)
      },
    )
  }

  useEffect(() => {
    if (!ready) return
    let alive = true
    window.taskminal.history.list().then(
      (loaded) => {
        if (!alive) return
        setPrevIds(new Set(loaded.map((e) => e.id)))
        setAll((cur) => mergeEntries(loaded, cur))
      },
      () => {},
    )
    return () => void (alive = false)
  }, [ready])

  return {
    entries: hidden.size === 0 ? all : all.filter((e) => !hidden.has(e.id)),
    prevIds,
    saveFailed,
    add: (entry) => {
      setAll((cur) => [...cur, entry])
      queue.current = [...queue.current, entry].slice(-QUEUE_MAX)
      flush()
    },
    retry: flush,
    hide: (ids) => setHidden((h) => new Set([...h, ...ids])),
    unhide: (ids) =>
      setHidden((h) => {
        const next = new Set(h)
        for (const id of ids) next.delete(id)
        return next
      }),
    drop: (taskId, ids) => {
      const gone = new Set(ids)
      // 아직 보내지 못한 줄이면 보내지도 않는다
      queue.current = queue.current.filter((e) => !gone.has(e.id))
      setAll((cur) => cur.filter((e) => !gone.has(e.id)))
      window.taskminal.history.remove(taskId, [...ids])
    },
    dropTask: (taskId) => {
      queue.current = queue.current.filter((e) => e.taskId !== taskId)
      setAll((cur) => cur.filter((e) => e.taskId !== taskId))
      window.taskminal.history.removeTask(taskId)
    },
    clearAll: async () => {
      queue.current = []
      await window.taskminal.history.clear()
      setAll([])
      setSaveFailed(false)
    },
  }
}
