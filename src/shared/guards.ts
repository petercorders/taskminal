// 저장 파일 · IPC 로 받은 값을 검사하는 작은 도우미 (model · settings 가 함께 쓴다)

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
