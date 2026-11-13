import { accelFromEvent as fromEvent, accelLabel as label, commandForKey as command, type KeyLike, type Shortcut, type PrimaryModifier } from '../shared/keymap'

// Node/Electron API 없이 브라우저가 제공하는 OS만 읽는다. 저장 형식은 플랫폼을 옮겨도 유지한다.
export const primaryModifier: PrimaryModifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'meta' : 'control'
export const commandForKey = (event: KeyLike, table?: readonly Shortcut[]) => command(event, table, primaryModifier)
export const accelFromEvent = (event: KeyLike) => fromEvent(event, primaryModifier)
export const accelLabel = (accel: string) => label(accel, primaryModifier)
