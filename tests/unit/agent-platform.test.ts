import { describe, expect, it } from 'vitest'
import { AgentBinFinder, agentLaunch } from '../../src/main/chat/find-bin'

describe('Windows 에이전트 찾기', () => {
  it('네이티브 exe는 셸 없이 실행하고 Windows PATH를 유지한다', async () => {
    const calls: string[][] = []
    const finder = new AgentBinFinder({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows' }, async (file, args) => {
      calls.push([file, ...args]); return 'C:\\bin\\claude.exe\r\n'
    }, 'win32')
    expect(await finder.claude()).toEqual({ bin: 'C:\\bin\\claude.exe', path: 'C:\\bin' })
    expect(calls[0]).toEqual(['C:\\Windows\\System32\\where.exe', 'claude'])
  })
  it('npm cmd shim은 고정 패키지 JS를 Electron node 모드로 열고 cmd.exe에 글을 넘기지 않는다', async () => {
    const finder = new AgentBinFinder({ PATH: 'C:\\npm' }, async () => 'C:\\npm\\codex.cmd\r\n', 'win32', () => true)
    const found = await finder.codex()
    expect(found?.args).toEqual(['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'])
    const launch = agentLaunch(found!, ['app-server', '--listen', 'stdio://'], { PATH: 'C:\\npm' })
    expect(launch.bin).toBe(process.execPath)
    expect(launch.args).toEqual([...(found!.args ?? []), 'app-server', '--listen', 'stdio://'])
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
  it('알 수 없는 배치 파일만 있으면 실행하지 않고 찾지 못함으로 남긴다', async () => {
    const finder = new AgentBinFinder({}, async () => 'C:\\other\\claude.cmd\r\n', 'win32', () => false)
    expect(await finder.claude()).toBeNull()
  })
})
