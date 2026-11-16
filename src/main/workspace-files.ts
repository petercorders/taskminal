import { realpath, readdir, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, relative, isAbsolute, extname, sep } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { redact, type SecretOptions } from '../shared/redact'
import type { WorkspaceEntry, WorkspaceFile } from '../shared/workspace'

const sensitive = (p: string) =>
  p
    .split(/[\\/]/)
    .some((n) => /^(\.env(?:\..*)?|\.git|\.ssh|\.aws|credentials(?:\.json)?|auth\.json|id_(rsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i.test(n))
export class WorkspaceFiles {
  constructor(private readonly secretOptions: () => SecretOptions = () => ({})) {}
  async path(root: string, path: string): Promise<string> {
    if (typeof root !== 'string' || typeof path !== 'string' || root.length > 4096 || path.length > 4096 || path.includes('\0') || sensitive(path))
      throw new Error('이 파일은 열 수 없어요')
    const r = await realpath(root === '~' ? homedir() : root.startsWith('~/') ? resolve(homedir(), root.slice(2)) : root)
    const p = await realpath(resolve(r, path))
    const rel = relative(r, p)
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || sensitive(rel)) throw new Error('일감 폴더 밖의 파일은 열 수 없어요')
    return p
  }
  async list(root: string, path: string): Promise<WorkspaceEntry[]> {
    const dir = await this.path(root, path)
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => !sensitive(e.name) && e.name !== 'node_modules')
      .slice(0, 1000)
      .map((e) => ({
        name: e.name,
        path: path ? path.replace(/\/$/, '') + '/' + e.name : e.name,
        directory: e.isDirectory(),
      }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
  }
  async read(root: string, path: string): Promise<WorkspaceFile> {
    const p = await this.path(root, path)
    const s = await lstat(p)
    if (!s.isFile()) throw new Error('파일을 골라 주세요')
    const ext = extname(p).toLowerCase()
    const image = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)
    const pdf = ext === '.pdf'
    const limit = image || pdf ? 10_000_000 : 2_000_000
    if (s.size > limit) throw new Error(image || pdf ? '10 MB 이하 파일만 미리 볼 수 있어요' : '2 MB 이하 파일만 미리 볼 수 있어요')
    // Bound the read even if a writer grows the file after stat.
    const { open } = await import('node:fs/promises')
    const handle = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      const opened = await handle.stat(),
        now = await lstat(p)
      if (opened.dev !== s.dev || opened.ino !== s.ino || opened.dev !== now.dev || opened.ino !== now.ino || (await this.path(root, path)) !== p)
        throw new Error('읽는 사이 파일이 바뀌었어요')
      const data = Buffer.alloc(limit + 1)
      const { bytesRead } = await handle.read(data, 0, data.length, 0)
      if (bytesRead > limit) throw new Error('미리보기 크기 한도를 넘었어요')
      bytes = data.subarray(0, bytesRead)
      const final = await lstat(p)
      if (final.dev !== opened.dev || final.ino !== opened.ino || (await this.path(root, path)) !== p) throw new Error('읽는 사이 파일이 바뀌었어요')
    } finally {
      await handle.close()
    }
    const signature = createHash('sha256').update(bytes).digest('hex')
    const common = { path, signature, size: bytes.length }
    if (pdf || image) {
      const mime = pdf ? 'application/pdf' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`
      return { ...common, kind: pdf ? 'pdf' : 'image', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
    }
    if (bytes.includes(0)) return { ...common, kind: 'binary' }
    return { ...common, kind: 'text', text: redact(bytes.toString('utf8'), this.secretOptions()) }
  }
}
