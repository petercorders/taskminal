import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BackupInfo } from '../shared/backup'
import { IPC, type AppInfo, type BackupMark, type HostView, type LoadedState, type PtyAttachResult, type PtyExit, type RedactStatus, type ScrollbackEntry } from '../shared/ipc'
import type { LogRow } from '../shared/errlog'
import type { HistoryEntry } from '../shared/history'
import type { ProbeResult } from '../shared/ports'
import type { ChatEvent } from '../shared/chat'
import type { UpdateView } from '../shared/update'
import type { AppState } from '../shared/types'
import type { SessionInfo } from '../shared/ptyhost'
import type { WorktreeResult } from '../shared/worktree'
import type { ChatApi as ChatApiT, ReviewApi as ReviewApiT, TaskminalApi } from './api'

// renderer 에 여는 유일한 통로. ipcRenderer 자체나 채널 이름을 받는 함수는 열지 않는다.
// 이벤트 객체(sender 등)는 renderer 에 넘기지 않는다.
const subscribe = <A extends unknown[]>(channel: string, listener: (...args: A) => void): (() => void) => {
  const wrapped = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as A))
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: TaskminalApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder) as Promise<string | null>,
  onCommand: (listener) => subscribe<[unknown]>(IPC.appCommand, listener),
  setQuitGuard: (busy) => ipcRenderer.send(IPC.quitGuard, busy),
  setBadge: (count) => ipcRenderer.send(IPC.badge, count),
  beep: () => ipcRenderer.send(IPC.beep),
  gitWorktreeAdd: (dir, branch) => ipcRenderer.invoke(IPC.gitWorktreeAdd, dir, branch) as Promise<WorktreeResult>,
  gitBranches: (dirs) => ipcRenderer.invoke(IPC.gitBranches, dirs) as Promise<Record<string, string | null>>,
  openLink: (url) => ipcRenderer.send(IPC.openLink, url),
  setMenuKeys: (keys) => ipcRenderer.send(IPC.menuKeys, keys),
  pty: {
    attach: (paneId) => ipcRenderer.invoke(IPC.ptyAttach, paneId) as Promise<PtyAttachResult>,
    spawn: (paneId, opts) => ipcRenderer.invoke(IPC.ptySpawn, paneId, opts) as Promise<void>,
    write: (paneId, data) => ipcRenderer.send(IPC.ptyWrite, paneId, data),
    resize: (paneId, cols, rows) => ipcRenderer.send(IPC.ptyResize, paneId, cols, rows),
    kill: (paneId) => ipcRenderer.send(IPC.ptyKill, paneId),
    onData: (listener) => subscribe<[string, string]>(IPC.ptyData, listener),
    onExit: (listener) => subscribe<[string, PtyExit]>(IPC.ptyExit, listener),
    cwds: (paneIds) => ipcRenderer.invoke(IPC.ptyCwds, paneIds) as Promise<Record<string, string>>,
  },
  scrollback: {
    load: (paneId) => ipcRenderer.invoke(IPC.scrollbackLoad, paneId) as Promise<ScrollbackEntry | null>,
    save: (req) => ipcRenderer.send(IPC.scrollbackSave, req),
    saveNow: (req) => {
      ipcRenderer.sendSync(IPC.scrollbackSaveSync, req)
    },
  },
  state: {
    load: () => ipcRenderer.invoke(IPC.stateLoad) as Promise<LoadedState>,
    save: (state) => ipcRenderer.send(IPC.stateSave, state),
    onError: (listener) => subscribe<[string]>(IPC.stateError, listener),
    exportTo: () => ipcRenderer.invoke(IPC.stateExport) as Promise<string | null>,
    importFrom: () => ipcRenderer.invoke(IPC.stateImport) as Promise<{ name: string; state: AppState } | null>,
  },
  backup: {
    list: () => ipcRenderer.invoke(IPC.backupList) as Promise<BackupInfo[]>,
    read: (name) => ipcRenderer.invoke(IPC.backupRead, name) as Promise<AppState>,
    mark: (what: BackupMark) => ipcRenderer.invoke(IPC.backupMark, what) as Promise<boolean>,
    onError: (listener) => subscribe<[string | null]>(IPC.backupError, listener),
  },
  redact: {
    status: () => ipcRenderer.invoke(IPC.redactStatus) as Promise<RedactStatus>,
    onStatus: (listener) => subscribe<[RedactStatus]>(IPC.redactStatus, listener),
    fix: (action, name) => ipcRenderer.send(IPC.redactFix, action, name),
  },
  host: {
    view: () => ipcRenderer.invoke(IPC.hostView) as Promise<HostView>,
    onView: (listener) => subscribe<[HostView]>(IPC.hostView, listener),
    sessions: (clearUnseen = false) => ipcRenderer.invoke(IPC.hostSessions, clearUnseen) as Promise<SessionInfo[]>,
    tail: (paneId) => ipcRenderer.invoke(IPC.hostTail, paneId) as Promise<string>,
    kill: (paneIds) => ipcRenderer.send(IPC.hostKill, paneIds),
    action: (action) => ipcRenderer.send(IPC.hostAction, action),
  },
  update: {
    view: () => ipcRenderer.invoke(IPC.updateView) as Promise<UpdateView>,
    onView: (listener) => subscribe<[UpdateView]>(IPC.updateView, listener),
    action: (action) => ipcRenderer.send(IPC.updateAction, action),
  },
  errlog: {
    list: (level) => ipcRenderer.invoke(IPC.errlogList, level) as Promise<LogRow[]>,
    openFolder: () => ipcRenderer.send(IPC.errlogOpen),
  },
  firstRunDone: () => ipcRenderer.send(IPC.firstRunDone),
  history: {
    list: () => ipcRenderer.invoke(IPC.historyList) as Promise<HistoryEntry[]>,
    append: (entries) => ipcRenderer.invoke(IPC.historyAppend, entries) as Promise<number>,
    remove: (taskId, ids) => ipcRenderer.send(IPC.historyRemove, taskId, ids),
    removeTask: (taskId) => ipcRenderer.send(IPC.historyRemoveTask, taskId),
    clear: () => ipcRenderer.invoke(IPC.historyClear) as Promise<void>,
  },
  chat: {
    send: (paneId, text, cwd, chat, images) => ipcRenderer.invoke(IPC.chatSend, paneId, text, cwd, chat, images) as Promise<'ok' | 'busy' | 'missing'>,
    rewind: (paneId, index, at, chat) => ipcRenderer.invoke(IPC.chatRewind, paneId, index, at, chat) as ReturnType<ChatApiT['rewind']>,
    branch: (from, to, index, at) => ipcRenderer.invoke(IPC.chatBranch, from, to, index, at) as ReturnType<ChatApiT['branch']>,
    pickImages: () => ipcRenderer.invoke(IPC.chatPickImages) as ReturnType<ChatApiT['pickImages']>,
    answer: (paneId, requestId, decision) => ipcRenderer.send(IPC.chatAnswer, paneId, requestId, decision),
    interrupt: (paneId) => ipcRenderer.send(IPC.chatInterrupt, paneId),
    history: (paneId) => ipcRenderer.invoke(IPC.chatHistory, paneId) as Promise<{ events: ChatEvent[]; upTo: number }>,
    close: (paneId, forget) => ipcRenderer.send(IPC.chatClose, paneId, forget),
    onEvent: (listener) => subscribe(IPC.chatEvent, listener),
  },
  review: {
    load: (dir, base) => ipcRenderer.invoke(IPC.reviewLoad, dir, base) as ReturnType<ReviewApiT['load']>,
    revertLines: (dir, path, sig, keys) => ipcRenderer.invoke(IPC.reviewRevertLines, dir, path, sig, keys) as ReturnType<ReviewApiT['revertLines']>,
    revertFile: (dir, path, sig) => ipcRenderer.invoke(IPC.reviewRevertFile, dir, path, sig) as ReturnType<ReviewApiT['revertFile']>,
    restore: (id) => ipcRenderer.invoke(IPC.reviewRestore, id) as ReturnType<ReviewApiT['restore']>,
    reverted: (root) => ipcRenderer.invoke(IPC.reviewReverted, root) as ReturnType<ReviewApiT['reverted']>,
    clearReverted: () => ipcRenderer.invoke(IPC.reviewClearReverted) as Promise<void>,
    commit: (dir, paths, message, sigs) => ipcRenderer.invoke(IPC.reviewCommit, dir, paths, message, sigs) as ReturnType<ReviewApiT['commit']>,
    undoCommit: (dir, hash) => ipcRenderer.invoke(IPC.reviewUndoCommit, dir, hash) as ReturnType<ReviewApiT['undoCommit']>,
    watch: (paneId, root) => ipcRenderer.send(IPC.reviewWatch, paneId, root),
    onChanged: (listener) => subscribe<[string]>(IPC.reviewChanged, listener),
    openFile: (root, path) => ipcRenderer.send(IPC.reviewOpenFile, root, path),
  },
  ports: {
    probe: (paneIds) => ipcRenderer.invoke(IPC.portsProbe, paneIds) as Promise<ProbeResult>,
    kill: (paneId, port, pid) => ipcRenderer.invoke(IPC.portsKill, paneId, port, pid) as Promise<'killed' | 'gone' | 'failed'>,
  },
}

contextBridge.exposeInMainWorld('taskminal', api)
