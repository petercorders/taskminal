import { describe, expect, it } from 'vitest'
import { claudeHandoff } from '../../src/shared/chat-handoff'

const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'

describe('Claude 대화 인계', () => {
  it('최근 요청과 파일과 대화 상태를 담고 확인되지 않은 검사를 통과로 쓰지 않는다', () => {
    const draft = claudeHandoff([
      { t: 'user', at: 1, text: '이전 목표' },
      { t: 'user', at: 2, text: `최근 목표 ${secret}` },
      { t: 'text', text: '확인했다는 이전 답변' },
      { t: 'turn_end', ok: true, ms: 1, reason: 'completed' },
    ], ['src/a.ts', 'src/a.ts', 'src/b.ts'])
    expect(draft).toContain('최근 목표')
    expect(draft).not.toContain('이전 목표')
    expect(draft).not.toContain(secret)
    expect(draft.match(/src\/a\.ts/g)).toHaveLength(1)
    expect(draft).toContain('미확인')
    expect(draft).toContain('확인했다는 이전 답변')
  })

  it('검사 도구 결과는 과거 관측으로만 싣고 복합 셸 명령은 결과에 포함하지 않는다', () => {
    const draft = claudeHandoff([
      { t: 'user', at: 1, text: '수정' },
      { t: 'tool', id: '1', name: 'Bash', summary: 'npm test -- tests/unit/a.test.ts' },
      { t: 'tool_end', id: '1', ok: true, tail: '1 passed' },
      { t: 'tool', id: '2', name: 'Bash', summary: 'npm run typecheck' },
      { t: 'tool_end', id: '2', ok: false, tail: 'error TS2700' },
      { t: 'tool', id: '3', name: 'Bash', summary: 'npm test; true' },
      { t: 'tool_end', id: '3', ok: true, tail: '' },
    ], [])
    expect(draft).toContain('npm test -- tests/unit/a.test.ts · 도구 성공')
    expect(draft).toContain('npm run typecheck · 도구 오류')
    expect(draft).not.toContain('npm test; true')
    expect(draft).toContain('현재 커밋의 검사 결과 미확인')
  })

  it('실패, Git 조회 불가, 열린 대화를 따로 표시한다', () => {
    expect(claudeHandoff([{ t: 'user', at: 1, text: '수정' }, { t: 'stopped' }], null)).toContain('대화 중단')
    expect(claudeHandoff([{ t: 'user', at: 1, text: '수정' }], null)).toContain('변경 파일 미확인')
    expect(claudeHandoff([{ t: 'user', at: 1, text: '수정' }], [])).toContain('이전 대화 실행 중')
  })
})
