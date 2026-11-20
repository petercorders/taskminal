/** main 이 던진 오류 앞에 Electron 이 붙이는 말 — `Error invoking remote method '<채널>': Error: ` */
const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/

/**
 * IPC 로 온 오류에서 사용자에게 보일 글 — Error 면 Electron 머리를 걷은 message, 아니면 fallback.
 * 빈 message 도 fallback 이다(비었는지는 걷기 전에 본다). keepEmpty 면 빈 message 를 빈 글 그대로 돌려준다
 * — App · 백업 · 워크트리 화면이 모으기 전부터 그렇게 했다.
 */
export function ipcMessage(e: unknown, fallback: string, opts: { keepEmpty?: boolean } = {}): string {
  if (!(e instanceof Error)) return fallback
  if (!e.message && !opts.keepEmpty) return fallback
  return e.message.replace(IPC_PREFIX, '')
}
