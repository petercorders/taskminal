import { describe, expect, it } from 'vitest'
import { blockedReason, compareVersions, noteSummary, releasePage, updateErrorText } from '../../src/shared/update'

describe('compareVersions', () => {
  it('숫자 칸을 차례로 비교한다 (글자 비교가 아님)', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v0.1.1', '0.1.1')).toBe(0)
  })
  it('미리 보기(-beta)는 같은 번호의 정식보다 낮다', () => {
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('0.2.0', '0.2.0-beta.1')).toBeGreaterThan(0)
  })
})

describe('noteSummary', () => {
  it('글이면 줄머리 기호를 떼고 앞 세 줄 + 나머지 수', () => {
    expect(noteSummary('## 0.2.0\n- 대화 pane\n- 변경 검토\n* 고친 것 12개\n- 하나\n- 둘')).toEqual({ lines: ['대화 pane', '변경 검토', '고친 것 12개'], more: 2 })
  })
  it('HTML(GitHub 릴리스 본문)은 태그를 걷어 낸다', () => {
    expect(noteSummary('<ul><li>대화 pane</li><li>고침 &amp; 정리</li></ul>')).toEqual({ lines: ['대화 pane', '고침 & 정리'], more: 0 })
  })
  it('버전별 목록이면 이어 붙이고, 없거나 모르는 모양이면 빈 요약', () => {
    expect(noteSummary([{ version: '0.2.0', note: '- 가\n- 나' }, { version: '0.1.1', note: '- 다' }])).toEqual({ lines: ['가', '나', '다'], more: 0 })
    expect(noteSummary(null)).toEqual({ lines: [], more: 0 })
    expect(noteSummary(42)).toEqual({ lines: [], more: 0 })
  })
  it('한 줄이 너무 길면 자른다', () => {
    expect(noteSummary('- ' + '가'.repeat(200)).lines[0]!.length).toBeLessThanOrEqual(81)
  })
})

describe('updateErrorText', () => {
  it('연결 · 서명 · 디스크 · 없는 릴리스를 사용자 말로', () => {
    expect(updateErrorText(Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }))).toBe('연결이 끊겼어요')
    expect(updateErrorText(new Error('net::ERR_CONNECTION_REFUSED'))).toBe('연결이 끊겼어요')
    expect(updateErrorText(new Error('Could not get code signature for running application'))).toBe('서명을 확인할 수 없어요')
    expect(updateErrorText(new Error('Code signature at URL … did not pass validation'))).toBe('서명을 확인할 수 없어요')
    expect(updateErrorText(Object.assign(new Error('no space'), { code: 'ENOSPC' }))).toBe('디스크에 자리가 없어요')
    expect(updateErrorText(new Error('HttpError: 404 Not Found'))).toBe('받는 곳에 새 버전 정보가 없어요')
    expect(updateErrorText(new Error('sha512 checksum mismatch'))).toBe('받은 파일이 손상됐어요')
    expect(updateErrorText('이상한 것')).toBe('알 수 없는 오류예요')
  })
})

describe('blockedReason', () => {
  it('디스크 이미지 안 · 쓸 수 없는 폴더면 업데이트를 받을 수 없다', () => {
    expect(blockedReason('/Volumes/Taskminal 0.1.0/Taskminal.app/Contents/MacOS/Taskminal', true)).toBe('dmg')
    expect(blockedReason('/Applications/Taskminal.app/Contents/MacOS/Taskminal', false)).toBe('readonly')
    // 내려받은 zip 을 옮기지 않고 열면 macOS 가 읽기 전용 임시 자리로 옮긴다 — 옮기기로 풀리는 자리 (18단계 리뷰)
    expect(blockedReason('/private/var/folders/ab/xyz/T/AppTranslocation/1234-ABCD/d/Taskminal.app/Contents/MacOS/Taskminal', false)).toBe('translocated')
    expect(blockedReason('/Applications/Taskminal.app/Contents/MacOS/Taskminal', true)).toBeNull()
  })
})

it('releasePage: 버전 태그 주소', () => {
  expect(releasePage('0.2.0')).toBe('https://github.com/petercorders/taskminal/releases/tag/v0.2.0')
})
