import type { EditableFile, EditorSave, EditorSaveResult, WorkspaceEntry } from './workspace'
import type { ChatAgent, ChatEvent, ChatDecision } from './chat'
export interface RemoteConnection { id: string; url: string }
export interface RemoteTerminal { id: string; title: string; exited?: number }
export interface RemoteChat { id: string; agent: ChatAgent }
export interface RemoteWorkspace { id: string; name: string; path: string; sessions: RemoteTerminal[]; chats: RemoteChat[] }
export interface RemoteGit { status: string; diff: string; branch: string }
export interface RemoteApi {
  connect(url: string, token: string): Promise<RemoteConnection>
  disconnect(id: string): Promise<void>
  workspaces(id: string): Promise<RemoteWorkspace[]>
  open(id: string, path: string, requestId: string): Promise<RemoteWorkspace>
  files(id: string, workspace: string, path: string): Promise<WorkspaceEntry[]>
  read(id: string, workspace: string, path: string): Promise<EditableFile>
  save(id: string, workspace: string, path: string, input: EditorSave, requestId: string): Promise<EditorSaveResult>
  git(id: string, workspace: string): Promise<RemoteGit>
  terminal(id: string, workspace: string, requestId: string): Promise<RemoteTerminal>
  tail(id: string, workspace: string, session: string): Promise<{data: string; exited?: number}>
  write(id: string, workspace: string, session: string, input: {requestId: string; data: string}): Promise<void>
  stop(id: string, workspace: string, session: string): Promise<void>
  chat(id: string, workspace: string, agent: ChatAgent, requestId: string): Promise<RemoteChat>
  send(id: string, workspace: string, chat: string, text: string, requestId: string): Promise<void>
  history(id: string, workspace: string, chat: string): Promise<{events: ChatEvent[]; upTo: number}>
  answer(id: string, workspace: string, chat: string, requestId: string, decision: ChatDecision): Promise<boolean>
  interrupt(id: string, workspace: string, chat: string): Promise<void>
}
