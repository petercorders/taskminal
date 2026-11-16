import { describe, expect, it } from 'vitest'
import { isAppPage } from '../../src/main/page-origin'

describe('패키지 renderer 출처 확인', () => {
  it('Windows file URL을 실제 drive 경로로 바꾸어 신뢰한다', () => {
    expect(isAppPage('file:///D:/a/taskminal/resources/app.asar/out/renderer/index.html', 'D:\\a\\taskminal\\resources\\app.asar\\out\\renderer\\index.html', undefined, 'win32')).toBe(true)
  })
  it('Windows 경로 대소문자와 공백·한글 URL 인코딩을 다룬다', () => {
    expect(isAppPage('file:///c:/Program%20Files/%ED%95%9C%EA%B8%80/index.html', 'C:\\Program Files\\한글\\INDEX.HTML', undefined, 'win32')).toBe(true)
  })
  it('macOS/Linux의 file URL과 기존 query/hash를 유지한다', () => {
    expect(isAppPage('file:///Applications/Taskminal.app/Contents/Resources/index.html?x=1#pane', '/Applications/Taskminal.app/Contents/Resources/index.html', undefined, 'darwin')).toBe(true)
    expect(isAppPage('file:///opt/taskminal/index.html', '/opt/taskminal/index.html', undefined, 'linux')).toBe(true)
  })
  it('다른 파일과 이름 접두사가 같은 파일을 거절한다', () => {
    const expected = 'D:\\app\\index.html'
    expect(isAppPage('file:///D:/app/index.html.evil', expected, undefined, 'win32')).toBe(false)
    expect(isAppPage('file:///D:/other/index.html', expected, undefined, 'win32')).toBe(false)
  })
  it('외부 file 호스트와 다른 drive를 거절한다', () => {
    expect(isAppPage('file://evil.example/D:/app/index.html', 'D:\\app\\index.html', undefined, 'win32')).toBe(false)
    expect(isAppPage('file:///E:/app/index.html', 'D:\\app\\index.html', undefined, 'win32')).toBe(false)
  })
  it('인코딩한 경로 구분자와 깨진 퍼센트 인코딩을 거절한다', () => {
    expect(isAppPage('file:///D:/app%2findex.html', 'D:\\app\\index.html', undefined, 'win32')).toBe(false)
    expect(isAppPage('file:///D:/app%5cindex.html', 'D:\\app\\index.html', undefined, 'win32')).toBe(false)
    expect(isAppPage('file:///D:/app/%FF', 'D:\\app\\index.html', undefined, 'win32')).toBe(false)
  })
  it('개발 서버는 정확한 origin만 허용한다', () => {
    expect(isAppPage('http://localhost:5173/settings', '/unused', 'http://localhost:5173', 'win32')).toBe(true)
    expect(isAppPage('http://localhost:5174/settings', '/unused', 'http://localhost:5173', 'win32')).toBe(false)
    expect(isAppPage('http://localhost.evil:5173/', '/unused', 'http://localhost:5173', 'win32')).toBe(false)
  })
  it('릴리스에서는 웹 주소·상대 파일 경로·잘못된 URL을 거절한다', () => {
    expect(isAppPage('https://evil.example/index.html', 'D:\\app\\index.html', undefined, 'win32')).toBe(false)
    expect(isAppPage('file:///D:/app/index.html', 'app/index.html', undefined, 'win32')).toBe(false)
    expect(isAppPage('not a url', '/app/index.html', undefined, 'linux')).toBe(false)
  })
})
