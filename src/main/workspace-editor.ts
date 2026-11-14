import { constants } from 'node:fs'
import { open, realpath, lstat, rename, unlink } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { WorkspaceFiles } from './workspace-files'
import type { EditableFile, EditorSave, EditorSaveResult } from '../shared/workspace'

const LIMIT = 2_000_000
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
/** Raw editor text is separate from masked previews. No draft is written to app journals. */
export class WorkspaceEditor {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly files = new WorkspaceFiles()
  private async target(root: string, path: string) {
    const base = await realpath(root === '~' ? homedir() : root.startsWith('~/') ? resolve(homedir(), root.slice(2)) : root)
    const target = await this.files.path(base, path)
    if (resolve(base, path) !== target) throw new Error('심볼릭 링크는 편집할 수 없어요')
    return target
  }
  async read(root: string, path: string): Promise<EditableFile> {
    const target = await this.target(root, path)
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT) throw new Error('2 MB 이하 일반 텍스트 파일만 편집할 수 있어요')
      const buffer = Buffer.alloc(LIMIT + 1)
      const {bytesRead} = await file.read(buffer, 0, buffer.length, 0)
      const data = buffer.subarray(0, bytesRead)
      const after = await lstat(target)
      if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || await this.target(root, path) !== target) throw new Error('읽는 사이 파일이 바뀌었어요. 다시 열어 주세요')
      if (bytesRead > LIMIT || data.includes(0)) throw new Error('텍스트 파일만 편집할 수 있어요')
      const text = data.toString('utf8')
      if (!Buffer.from(text, 'utf8').equals(data)) throw new Error('UTF-8 텍스트 파일만 편집할 수 있어요')
      return {path, signature:hash(data), text}
    } finally { await file.close() }
  }
  async save(root: string, path: string, input: EditorSave): Promise<EditorSaveResult> {
    if (!input || typeof input.signature !== 'string' || !/^[a-f0-9]{64}$/.test(input.signature) || typeof input.text !== 'string' || Buffer.byteLength(input.text) > LIMIT || input.text.includes('\0')) throw new Error('저장할 텍스트와 파일 버전을 확인해 주세요')
    const target = await this.target(root, path)
    const previous = this.locks.get(target) ?? Promise.resolve()
    const operation = previous.catch(()=>{}).then(async (): Promise<EditorSaveResult> => {
      const current = await this.read(root, path)
      if (current.signature !== input.signature) return {ok:false,reason:'conflict',current}
      const before = await lstat(target)
      const temp = join(dirname(target), `.taskminal-edit-${randomUUID()}`)
      const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      try {
        await handle.writeFile(input.text, 'utf8')
        await handle.sync()
        await handle.chmod(before.mode & 0o777)
        const latest = await this.read(root, path)
        const final = await lstat(target)
        if (latest.signature !== input.signature || final.ino !== before.ino || final.dev !== before.dev) return {ok:false,reason:'conflict',current:latest}
        await rename(temp, target)
        return {ok:true,file:{path,signature:hash(Buffer.from(input.text,'utf8')),text:input.text}}
      } finally { await handle.close(); await unlink(temp).catch(()=>{}) }
    })
    this.locks.set(target, operation)
    try { return await operation } finally { if(this.locks.get(target)===operation)this.locks.delete(target) }
  }
}
