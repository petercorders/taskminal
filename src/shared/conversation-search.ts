import type { ChatAgent } from './chat'
export interface ConversationQuery { text: string; taskId?: string; agent?: ChatAgent; archived?: boolean }
export interface ConversationHit { taskId: string; paneId: string; agent: ChatAgent; taskName: string; archived: boolean; turn: number; at: number; role: 'user'|'assistant'; snippet: string; fingerprint: string }
export interface ConversationResult { hits: ConversationHit[]; more: boolean; errors: string[] }
export interface ConversationApi { search(query: ConversationQuery): Promise<ConversationResult>; verify(hit: ConversationHit): Promise<boolean> }

/** Stable user-message identity across disk trimming and renderer event indices. */
export const conversationMessage = (event: {text:string;at:number;images?:string[]}) => JSON.stringify([event.at,event.text,event.images??[]])
