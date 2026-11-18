// 일감 폴더의 파일 목록 · 내용 찾기 (65단계). git 이 아는 파일만(추적 + 무시되지 않은 새 파일) — 인자는 배열로 주고 셸을 거치지 않는다.
// 민감 파일(.env · 키 등)은 목록 · 결과에서 빼고, 결과 글은 비밀값을 가린다. 찾기는 폴더마다 한 번에 하나 — 새 요청이 앞 요청을 끝낸다.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { redact, type SecretOptions } from '../shared/redact'
import { FILES_MAX, GREP_MAX, GREP_TIMEOUT_MS, GrepParser, grepQuery, parseFileList, type GrepHit, type GrepResult } from '../shared/workspace-search'
import { sensitivePath } from './workspace-files'

// 사용자 셸의 GIT_* (다른 저장소를 가리키는 GIT_DIR 등)가 섞이지 않게
const gitEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))

export class WorkspaceSearch {
  private readonly running = new Map<string, ChildProcess>()
  constructor(
    private readonly secretOptions: () => SecretOptions = () => ({}),
    private readonly timeoutMs = GREP_TIMEOUT_MS,
  ) {}

  /** 그 폴더 아래의 파일들(폴더 기준 상대 경로). git 저장소가 아니거나 git 이 없으면 빈 목록 */
  files(root: string): Promise<string[]> {
    return new Promise((resolve) =>
      execFile('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, env: gitEnv(), encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, out) =>
        // 목록이 너무 커 잘렸어도(maxBuffer) 받은 데까지는 쓴다 — 마지막 조각은 잘린 경로일 수 있어 버린다
        resolve(error && !out ? [] : parseFileList(error ? out.slice(0, out.lastIndexOf('\0') + 1) : out, (p) => !sensitivePath(p), FILES_MAX)),
      ),
    )
  }

  /** 글자 그대로(대소문자 무시) 찾는다. 이진 파일은 뺀다. 상한 · 시간 한도에서 멈춘다 */
  grep(root: string, query: unknown): Promise<GrepResult> {
    const q = grepQuery(query)
    if (!q) return Promise.resolve({ hits: [], more: false, timedOut: false })
    this.running.get(root)?.kill('SIGKILL') // 앞 찾기는 버린다 — 그 요청은 지금까지 찾은 것으로 끝난다
    return new Promise((resolve) => {
      // -e 뒤에 주므로 '-' 로 시작하는 글도 옵션이 아니다. '--' 뒤는 경로
      const child = spawn('git', ['grep', '-n', '-I', '-F', '-i', '-z', '--no-color', '--untracked', '-e', q, '--', '.'], { cwd: root, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
      this.running.set(root, child)
      const parser = new GrepParser()
      const hits: GrepHit[] = []
      let more = false
      let timedOut = false
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (this.running.get(root) === child) this.running.delete(root)
        const opts = this.secretOptions()
        resolve({ hits: hits.map((h) => ({ ...h, text: redact(h.text, opts) })), more, timedOut })
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, this.timeoutMs)
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (chunk: string) => {
        if (more) return
        for (const hit of parser.push(chunk)) {
          if (sensitivePath(hit.path)) continue
          if (hits.length >= GREP_MAX) {
            more = true
            child.kill('SIGKILL')
            break
          }
          hits.push(hit)
        }
      })
      child.on('error', finish) // git 이 없다
      child.on('close', finish)
    })
  }

  dispose(): void {
    for (const child of this.running.values()) child.kill('SIGKILL')
    this.running.clear()
  }
}
