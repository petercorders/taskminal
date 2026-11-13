import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { firstWindow, seedState, waitLoaded } from './helpers'
let dir: string, app: ElectronApplication, win: Page, server: Server, url: string
async function shot(name:string,light=false){
  mkdirSync('test-results/workspace',{recursive:true})
  if(light)await win.evaluate(()=>{document.documentElement.dataset.theme='light'})
  await win.screenshot({path:`test-results/workspace/${name}.png`})
  if(light)await win.evaluate(()=>{document.documentElement.dataset.theme='dark'})
}
test.beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-tools-')))
  writeFileSync(join(dir, 'example.md'), '# 미리보기 제목\n줄 하나\n줄 둘')
  writeFileSync(join(dir, 'example.ts'), 'const secret = "safe";\nsecond line')
  seedState(dir, [{ id: 't', name: '검증 일감', paneId: 'p', cwd: dir }], [], {secretCustom: [{name:'내부값',pattern:'INTERNAL-[A-Z]{6}'}]})
  server = createServer((_q, r) => {
    r.setHeader('Content-Type', 'text/html; charset=utf-8')
    r.end(
      '<html><head><title>Local Preview</title></head><body><button class="target">선택할 요소 INTERNAL-ABCDEF</button><input type="password" value="private-secret"/></body></html>',
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: dir } })
  win = await firstWindow(app)
  await waitLoaded(win)
})
test.afterEach(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})
test('파일 탐색에서 Markdown을 미리 보고 줄 범위를 확인한 뒤 대화 입력에 넣는다', async () => {
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
  await win.getByRole('button', { name: 'example.md', exact: true }).click()
  await expect(win.getByRole('heading', { name: '미리보기 제목' })).toBeVisible()
  await shot('files-markdown-dark')
  await shot('files-markdown-light',true)
  await win.getByRole('spinbutton', { name: '첨부 시작 줄' }).fill('2')
  await win.getByRole('spinbutton', { name: '첨부 끝 줄' }).fill('3')
  await win.getByRole('button', { name: '확인한 내용을 대화에 추가' }).click()
  await expect(win.getByTestId('chat-input')).toHaveValue(/파일 example.md:2-3/)
  await expect(win.getByTestId('chat-input')).not.toHaveValue(/# 미리보기 제목/)
})
test('사용자 지정 비밀값은 파일 미리보기와 대화 초안에서도 가린다', async () => {
  writeFileSync(join(dir, 'internal.txt'), 'INTERNAL-ABCDEF')
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
  await win.getByRole('button', { name: 'internal.txt', exact: true }).click()
  await expect(win.locator('.work-source')).toContainText('가림')
  await expect(win.locator('.work-source')).not.toContainText('INTERNAL-ABCDEF')
  await win.getByRole('button', { name: '확인한 내용을 대화에 추가' }).click()
  await expect(win.getByTestId('chat-input')).not.toHaveValue(/INTERNAL-ABCDEF/)
  await expect(win.getByTestId('chat-input')).toHaveValue(/가림/)
})
test('확인 중 파일이 바뀌면 자동 첨부하지 않고 다시 확인하게 한다', async () => {
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
  await win.getByRole('button', { name: 'example.ts', exact: true }).click()
  await expect(win.locator('.work-source')).toContainText('second line')
  writeFileSync(join(dir, 'example.ts'), 'different')
  await win.getByRole('button', { name: '확인한 내용을 대화에 추가' }).click()
  await expect(win.getByRole('alert')).toContainText('파일이 바뀌었어요')
})
test('내장 웹은 앱 API가 없고 금지 주소·모달 가림·페이지 닫기를 지킨다', async () => {
  await win.getByRole('button', { name: '브라우저', exact: true }).click()
  await win.getByRole('textbox', { name: '브라우저 주소' }).fill(url)
  await win.getByRole('button', { name: '열기', exact: true }).click()
  await expect.poll(() => win.evaluate(() => window.taskminal.workspace.browserState('t'))).toMatchObject({ title: 'Local Preview', loading: false })
  const remote = await app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((w) => w.getURL().startsWith('http://127.0.0.1:'))
      .map((w) => w.id),
  )
  expect(remote).toHaveLength(1)
  expect(
    await app.evaluate(async ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('typeof window.taskminal + ":" + typeof require'), remote[0]!),
  ).toBe('undefined:undefined')
  // The test host does not foreground native windows. Observe the real IPC-to-focus
  // requests; do not claim OS focus delivery from CDP keyboard events.
  await app.evaluate(({ webContents, BrowserWindow }, id) => {
    const child = webContents.fromId(id)! as typeof BrowserWindow.prototype.webContents & { focusRequests?: number }
    const parent = BrowserWindow.getAllWindows()[0]!.webContents as typeof child
    for (const wc of [child, parent]) {
      const original = wc.focus.bind(wc)
      wc.focusRequests = 0
      wc.focus = () => {
        wc.focusRequests!++
        original()
      }
    }
  }, remote[0]!)
  await expect(win.getByRole('button', { name: '웹 화면으로 이동 · F6로 돌아오기' })).toBeEnabled()
  await win.getByRole('button', { name: '웹 화면으로 이동 · F6로 돌아오기' }).focus()
  await win.keyboard.press('Enter')
  await expect
    .poll(() => app.evaluate(({ webContents }, id) => (webContents.fromId(id) as unknown as { focusRequests: number }).focusRequests, remote[0]!))
    .toBeGreaterThan(0)
  await app.evaluate(({ webContents }, id) => {
    webContents.fromId(id)!.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'F6' })
  }, remote[0]!)
  expect(
    await app.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0]!.webContents as unknown as { focusRequests: number }).focusRequests),
  ).toBeGreaterThan(0)
  const trusted = await win.evaluate(() =>
    window.taskminal.workspace.browserNavigate('t', 'file:///etc/passwd').then(
      () => false,
      () => true,
    ),
  )
  expect(trusted).toBe(true)
  await win.getByRole('button', { name: '화면 캡처' }).click()
  await expect(win.getByRole('img', { name: '웹 화면 캡처' })).toBeVisible()
  await win.getByRole('button', { name: '취소', exact: true }).click()
  await win.getByRole('button', { name: '페이지 닫기' }).click()
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getURL().startsWith('http://127.0.0.1:')).length))
    .toBe(0)
  // Explicit refresh must not resurrect a closed entry.
  await win.evaluate(() => window.taskminal.workspace.browserState('t'))
  expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getURL().startsWith('http://127.0.0.1:')).length)).toBe(0)
})
test('추가 계정 선택은 명확한 기본 표시를 제공하고 미지원 한도와 0%를 구별한다', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('accounts:status')
    ipcMain.handle('accounts:status', (_e, id) => ({
      state: id === 'default-claude' ? 'unsupported' : 'ready',
      display: '검증 계정',
      windows: id === 'default-claude' ? [] : [{ label: '5시간', used: 0 }],
      updatedAt: Date.now(),
      message: id === 'default-claude' ? '한도 조회 미지원' : undefined,
    }))
  })
  await win.getByRole('button', { name: '사용량·계정', exact: true }).click()
  await expect(win.getByRole('status')).toContainText('한도 수치 미지원')
  await win.getByLabel('계정 이름', { exact: true }).fill('개발 계정')
  await win.getByRole('button', { name: '계정 추가', exact: true }).click()
  await expect(win.getByRole('option', { name: '개발 계정' })).toHaveCount(1)
  await win.getByRole('combobox', { name: '확인할 계정' }).selectOption({ label: '개발 계정' })
  await expect(win.getByRole('progressbar')).toHaveAttribute('value', '0')
  await shot('accounts-zero-light',true)
  await win.getByRole('button', { name: '새 대화 기본으로 선택' }).click()
  await expect(win.getByRole('option', { name: '개발 계정 · 새 대화 기본' })).toHaveCount(1)
})
test('보조 화면은 작은 창·라이트·200%에서 키보드로 닫을 수 있고 입력이 창 밖으로 나가지 않는다', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    w.setSize(640, 520)
    w.webContents.setZoomFactor(2)
  })
  await expect.poll(() => win.evaluate(() => innerWidth)).toBe(320)
  await win.getByRole('combobox', { name: '작업 도구 선택' }).selectOption('browser')
  await win.getByRole('textbox', { name: '브라우저 주소' }).fill(url)
  const box = await win.getByRole('textbox', { name: '브라우저 주소' }).boundingBox()
  const size = await win.evaluate(() => innerWidth)
  expect(box!.x + box!.width).toBeLessThanOrEqual(size)
  await win.getByRole('button', { name: '작업 보조 화면 닫기' }).focus()
  await win.keyboard.press('Enter')
  await expect(win.getByTestId('workspace-browser')).toHaveCount(0)
  mkdirSync('test-results/workspace', { recursive: true })
  writeFileSync(
    'test-results/workspace/compact-200.png',
    Buffer.from(
      await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64')),
      'base64',
    ),
  )
})
test('PDF는 로컬 worker에서 페이지를 그리고 파일 참조 첨부임을 표시한다', async () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 44 >>\nstream\nBT /F1 20 Tf 25 220 Td (Preview PDF) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const offset = Buffer.byteLength(pdf)
  pdf +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`
  writeFileSync(join(dir, 'preview.pdf'), pdf)
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
  await win.getByRole('button', { name: 'preview.pdf', exact: true }).click()
  await expect.poll(() => win.locator('.work-pdf-canvas').evaluate((node: HTMLCanvasElement) => node.width)).toBeGreaterThan(300)
  await expect(win.getByText('PDF 읽는 중…')).toHaveCount(0)
  await expect(win.getByRole('alert')).toHaveCount(0)
  mkdirSync('test-results/workspace', { recursive: true })
  await win.screenshot({ path: 'test-results/workspace/pdf-preview.png' })
  await win.getByRole('button', { name: '파일 참조를 대화에 추가' }).click()
  await expect(win.getByTestId('chat-input')).toHaveValue(/파일 참조 \(내용 미전달\)/)
})
test('요소 선택은 입력값을 제외한 자료로 확인되며 모달과 확대에서 네이티브 뷰가 가리지 않는다', async () => {
  await win.getByRole('button', { name: '브라우저', exact: true }).click()
  await win.getByRole('textbox', { name: '브라우저 주소' }).fill(url)
  await win.getByRole('button', { name: '열기', exact: true }).click()
  await expect.poll(() => win.evaluate(() => window.taskminal.workspace.browserState('t'))).toMatchObject({ title: 'Local Preview' })
  await win.getByRole('button', { name: '요소 선택', exact: true }).click()
  await expect
    .poll(async () => {
      await app.evaluate(async ({ webContents }) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1:'))!
        await wc.executeJavaScript('document.querySelector(".target").click()')
      })
      return win.locator('.work-capture').count()
    })
    .toBe(1)
  await expect(win.locator('.work-capture')).toContainText('선택할 요소')
  await expect(win.locator('.work-capture')).not.toContainText('private-secret')
  await expect(win.locator('.work-capture')).not.toContainText('INTERNAL-ABCDEF')
  await expect(win.locator('.work-capture')).toContainText('가림')
  await win.getByRole('button', { name: '취소', exact: true }).click()
  await win.getByRole('button', { name: '새 일감', exact: true }).click()
  await expect(win.getByRole('dialog')).toBeVisible()
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!
          .contentView.children.filter((v) => v.constructor.name === 'WebContentsView')
          .map((v) => v.getVisible()),
      ),
    )
    .not.toContain(true)
  await win.keyboard.press('Escape')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2))
  const rect = await win.locator('.work-browser-surface').boundingBox()
  const content = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds())
  const x = Math.round(rect!.x * 2),
    y = Math.round(rect!.y * 2)
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!
          .contentView.children.filter((v) => v.getVisible())
          .map((v) => v.getBounds()),
      ),
    )
    .toContainEqual({
      x,
      y,
      width: Math.min(content.width - x, Math.round(rect!.width * 2)),
      height: Math.min(content.height - y, Math.round(rect!.height * 2)),
    })
})
test('GitHub PR 입력을 보존하며 병합 전에 대상 PR·브랜치·커밋을 확인한다', async () => {
  await app.evaluate(({ ipcMain }, root) => {
    let created = false
    const head = 'a'.repeat(40),
      target = { root, branch: 'feature', head, remote: 'origin', base: 'main', repo: 'example/repo', remoteUrl: 'https://github.com/example/repo.git' }
    const view = () => ({
      state: 'ok',
      root,
      branch: 'feature',
      head,
      remotes: ['origin'],
      target,
      upstream: 'origin/feature',
      ahead: 0,
      behind: 0,
      gh: 'ready',
      pr: created
        ? {
            number: 12,
            title: '기능 개선',
            url: 'https://github.com/example/repo/pull/12',
            state: 'OPEN',
            head,
            base: 'main',
            draft: false,
            review: 'APPROVED',
            checks: 'passed',
            mergeable: true,
          }
        : null,
    })
    for (const channel of ['git-workflow:view', 'git-workflow:create', 'git-workflow:merge']) ipcMain.removeHandler(channel)
    ipcMain.handle('git-workflow:view', view)
    ipcMain.handle('git-workflow:create', () => {
      created = true
      return { state: 'ok', message: 'PR을 만들었어요.' }
    })
    ipcMain.handle('git-workflow:merge', () => ({ state: 'changed', message: 'PR 커밋이 바뀌었어요. 다시 확인해 주세요.' }))
  }, dir)
  await win.getByRole('button', { name: 'GitHub', exact: true }).click()
  await win.getByRole('textbox', { name: 'PR 제목', exact: true }).fill('기능 개선')
  await win.getByRole('textbox', { name: 'PR 본문', exact: true }).fill('검증한 변경')
  await win.getByRole('button', { name: 'PR 만들기', exact: true }).click()
  await expect(win.locator('.git-workflow-pr')).toContainText('#12')
  await win.getByRole('button', { name: '병합 검토…', exact: true }).click()
  await expect(win.getByRole('alertdialog')).toContainText('main ← feature')
  await expect(win.getByRole('alertdialog').getByRole('button', { name: '취소', exact: true })).toBeFocused()
  await shot('github-merge-confirm')
  await expect(win.getByRole('alertdialog')).toContainText('aaaaaaaaaaaa')
  await win.getByRole('button', { name: '이 PR 병합', exact: true }).click()
  await expect(win.getByRole('alert')).toContainText('PR 커밋이 바뀌었어요')
})
test('긴 파일은 2,000줄씩 표시하고 다음 범위를 확인해 첨부한다', async () => {
  writeFileSync(join(dir, 'many.txt'), Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n'))
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
  await win.getByRole('button', { name: 'many.txt', exact: true }).click()
  await expect(win.locator('.work-line-number')).toHaveCount(2000)
  await win.getByRole('spinbutton', { name: '첨부 끝 줄' }).fill('3000')
  await win.getByRole('button', { name: '확인한 내용을 대화에 추가' }).click()
  await expect(win.getByRole('alert')).toContainText('2,000줄')
  await win.getByRole('spinbutton', { name: '첨부 시작 줄' }).fill('2001')
  await expect(win.locator('.work-line-number').first()).toHaveText('2001')
  await win.getByRole('button', { name: '확인한 내용을 대화에 추가' }).click()
  await expect(win.getByTestId('chat-input')).toHaveValue(/파일 many.txt:2001-3000/)
})
