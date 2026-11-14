import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { RemoteClients } from './client'

import { IPC } from '../../shared/ipc'
const arity: Record<string, number> = {workspaces:0,open:2,files:2,read:2,save:4,git:1,terminal:2,tail:2,write:3,stop:2,chat:3,send:4,history:2,answer:4,interrupt:2}
export function installRemoteIpc(trusted: (e: IpcMainInvokeEvent) => boolean) {
  const clients = new RemoteClients()
  ipcMain.handle(IPC.remoteRequest, async (e, method: unknown, args: unknown) => {
    if (!trusted(e)) throw Error('알 수 없는 프레임')
    if (typeof method !== 'string' || !Array.isArray(args)) throw Error('원격 요청 형식')
    if (method === 'connect' && args.length === 2) return clients.connect(args[0], args[1])
    if (method === 'disconnect' && args.length === 1) return clients.disconnect(args[0])
    if (!Object.hasOwn(arity, method) || args.length !== arity[method]! + 1) throw Error('지원하지 않는 원격 요청입니다')
    return clients.call(args[0], method, args.slice(1))
  })
  app.on('will-quit', () => clients.clear())
}
