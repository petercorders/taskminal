import { describe, expect, it, vi } from 'vitest'
import { BrowserTabsStore } from '../../src/main/browser-tabs-store'
import { storedBrowserUrl, validBrowserTabsJournal, type BrowserTabsJournal } from '../../src/shared/browser-tabs'

// The injected redactor recognizes the same complete GitHub token shape as production.
const redact = (text: string) => text.replace(/ghp_[A-Za-z0-9]{36,}/g, '‹가림:GitHub 토큰›')

function fixture() {
  let disk: BrowserTabsJournal = { tasks: [] }
  let sequence = 0
  let fail = false
  const valid = new Set(['task'])
  const store = { load: () => structuredClone(disk), save: vi.fn((value: BrowserTabsJournal) => { if (fail) throw new Error('disk failure'); disk = structuredClone(value) }) }
  const deps = { id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, validTask: (id: string) => valid.has(id), redact: (text: string) => text.replaceAll('secret', 'MASKED') }
  return { tabs: new BrowserTabsStore(store, deps), store, deps, valid, disk: () => disk, fail: () => { fail = true } }
}

describe('browser tab metadata', () => {
  it('keeps default navigation/title only in memory and queries never create task/tab', () => {
    const f = fixture()
    expect(f.tabs.view('task')).toBeNull()
    expect(() => f.tabs.captureTicket('task')).toThrow()
    const task = f.tabs.openTask('task')
    f.tabs.beginNavigation('task', task.selectedTabId, 'https://example.com/private?token=secret#secret')
    f.tabs.update('task', task.selectedTabId, { title: 'secret title' })
    expect(JSON.stringify(f.disk())).not.toContain('example.com')
    expect(JSON.stringify(f.disk())).not.toContain('secret')
    expect(f.tabs.view('task')!.tabs[0]!.url).toContain('token=secret')
  })
  it('persists only opt-in scrubbed URL/title and restores metadata without navigation', () => {
    const f = fixture(); const task = f.tabs.openTask('task')
    f.tabs.beginNavigation('task', task.selectedTabId, 'https://example.com/secret?token=secret#private')
    f.tabs.update('task', task.selectedTabId, { title: 'secret title' })
    f.tabs.setRemember('task', true)
    expect(f.disk().tasks[0]!.tabs[0]).toEqual({ id: task.selectedTabId, title: 'MASKED title' })
    const restored = new BrowserTabsStore(f.store, f.deps)
    expect(restored.view('task')!.tabs[0]!.url).toBe('')
    expect(restored.view('task')!.tabs[0]!.navigationEpoch).toBe(0)
    restored.setRemember('task', false)
    expect(f.disk().tasks[0]!.tabs[0]).toEqual({ id: task.selectedTabId })
  })
  it('bounds six tabs; close last creates fresh blank UUID; old callbacks never resurrect closed IDs', () => {
    const f = fixture(); const first = f.tabs.openTask('task').selectedTabId
    for (let index = 0; index < 5; index++) f.tabs.createTab('task')
    expect(() => f.tabs.createTab('task')).toThrow('6')
    f.tabs.closeTab('task', first)
    expect(f.tabs.update('task', first, { title: 'late' })).toBe(false)
    expect(() => f.tabs.selectTab('task', first)).toThrow()
    for (const tab of [...f.tabs.view('task')!.tabs]) f.tabs.closeTab('task', tab.id)
    const only = f.tabs.view('task')!
    expect(only.tabs).toHaveLength(1)
    expect(only.tabs[0]!.url).toBe('')
    expect(only.tabs[0]!.id).not.toBe(first)
  })
  it('invalidates captured results after tab selection, navigation, close, or task removal', () => {
    const f = fixture(); const original = f.tabs.openTask('task').selectedTabId
    let ticket = f.tabs.captureTicket('task')
    f.tabs.beginNavigation('task', original, 'https://example.com')
    expect(f.tabs.validCapture(ticket)).toBe(false)
    ticket = f.tabs.captureTicket('task')
    f.tabs.createTab('task'); f.tabs.selectTab('task', original)
    expect(f.tabs.validCapture(ticket)).toBe(false)
    ticket = f.tabs.captureTicket('task'); f.tabs.closeTab('task', original)
    expect(f.tabs.validCapture(ticket)).toBe(false)
    f.valid.delete('task')
    expect(() => f.tabs.openTask('task')).toThrow()
    expect(f.tabs.view('task')).toBeNull()
  })
  it('rejects unsafe URLs and journal corruption, and fails closed after write failure', () => {
    const f = fixture(); const id = f.tabs.openTask('task').selectedTabId
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:password@example.com']) expect(() => f.tabs.beginNavigation('task', id, url)).toThrow()
    f.fail(); expect(() => f.tabs.setRemember('task', true)).toThrow()
    expect(() => f.tabs.view('task')).toThrow()
    const corrupt = new BrowserTabsStore({ load: () => ({ tasks: [null] }) as unknown as BrowserTabsJournal, save: vi.fn() }, f.deps)
    expect(() => corrupt.view('task')).toThrow()
    expect(validBrowserTabsJournal({ tasks: [null] })).toBe(false)
  })
  it('accepts only the documented disk fields, never form values or unsanitized query URLs', () => {
    const f = fixture(); const tab = f.tabs.openTask('task').selectedTabId
    const task = { taskId: 'task', remember: false, selectedTabId: tab, tabs: [{ id: tab }] }
    expect(validBrowserTabsJournal({ tasks: [{ ...task, formData: { password: 'private' } }] })).toBe(false)
    expect(validBrowserTabsJournal({ tasks: [{ ...task, tabs: [{ id: tab, url: 'https://example.com/' }] }] })).toBe(false)
    expect(validBrowserTabsJournal({ tasks: [{ ...task, remember: true, tabs: [{ id: tab, url: 'https://example.com/?private=value' }] }] })).toBe(false)
  })
  it('caps metadata at 200 tasks and explicit forgetting only frees removed tasks', () => {
    const f = fixture()
    for (let index = 0; index < 200; index++) { const id = `task-${index}`; f.valid.add(id); f.tabs.openTask(id) }
    expect(() => f.tabs.openTask('task')).toThrow('200')
    expect(() => f.tabs.forgetTask('task-0')).toThrow('사용 중')
    f.valid.delete('task-0'); f.tabs.forgetTask('task-0')
    expect(f.tabs.openTask('task').tabs).toHaveLength(1)
    expect(f.tabs.view('task-0')).toBeNull()
    expect(() => f.tabs.openTask('task-0')).toThrow()
  })
  it('drops stale navigation/title updates and leaves other tab state intact', () => {
    const f = fixture(); const original = f.tabs.openTask('task').selectedTabId
    const epoch = f.tabs.beginNavigation('task', original, 'https://example.com/a').navigationEpoch
    f.tabs.beginNavigation('task', original, 'https://example.com/b')
    expect(f.tabs.update('task', original, { url: 'https://example.com/a', title: 'late title' }, epoch)).toBe(false)
    const second = f.tabs.createTab('task').selectedTabId
    f.tabs.beginNavigation('task', second, 'https://example.com/second')
    expect(f.tabs.view('task')!.tabs.find(tab => tab.id === original)!.url).toBe('https://example.com/b')
    expect(f.tabs.view('task')!.tabs.find(tab => tab.id === second)!.url).toBe('https://example.com/second')
  })
  it('keeps a title burst current in runtime with no journal IO until one owner flush', () => {
    const f = fixture(); const id = f.tabs.openTask('task').selectedTabId
    f.tabs.setRemember('task', true); f.store.save.mockClear()
    f.tabs.beginNavigation('task', id, 'https://example.com/secret?token=private', true)
    for (let index = 0; index < 1000; index++) f.tabs.update('task', id, { title: `secret-title-${index}` })
    expect(f.tabs.view('task')!.tabs[0]!.title).toBe('MASKED-title-999')
    expect(f.store.save).not.toHaveBeenCalled()
    f.tabs.flush()
    expect(f.store.save).toHaveBeenCalledTimes(1)
    expect(f.disk().tasks[0]!.tabs[0]).toEqual({ id, title: 'MASKED-title-999' })
    f.tabs.flush(); expect(f.store.save).toHaveBeenCalledTimes(1)
    f.deps.redact = text => text.replaceAll('secret', 'CURRENT')
    f.tabs.flush()
    expect(f.disk().tasks[0]!.tabs[0]!.title).toBe('MASKED-title-999')
    f.tabs.update('task', id, { title: 'secret-title-new' }); f.tabs.flush()
    expect(f.disk().tasks[0]!.tabs[0]!.title).toBe('CURRENT-title-new')
  })
  it('flushes selection immediately and disabling remember clears queued private data now', () => {
    const f = fixture(); const id = f.tabs.openTask('task').selectedTabId
    const second = f.tabs.createTab('task').selectedTabId
    f.tabs.setRemember('task', true); f.store.save.mockClear()
    f.tabs.update('task', second, { title: 'queued title', url: 'https://example.com/secret?private=value' })
    expect(f.store.save).not.toHaveBeenCalled()
    f.tabs.selectTab('task', id)
    expect(f.disk().tasks[0]!.tabs.find(tab => tab.id === second)!.title).toBe('queued title')
    f.tabs.update('task', second, { title: 'more private' })
    f.tabs.setRemember('task', false)
    expect(f.disk().tasks[0]!.tabs).toEqual([{ id }, { id: second }])
    const saved = f.store.save.mock.calls.length
    f.tabs.flush(); expect(f.store.save).toHaveBeenCalledTimes(saved)
  })
  it('fails closed if a deferred flush cannot be saved', () => {
    const f = fixture(); const id = f.tabs.openTask('task').selectedTabId
    f.tabs.setRemember('task', true)
    f.tabs.update('task', id, { title: 'unsaved' })
    f.fail()
    expect(() => f.tabs.flush()).toThrow('disk failure')
    expect(f.tabs.failureReason).toBe('disk failure')
    expect(() => f.tabs.view('task')).toThrow()
    expect(f.disk().tasks[0]!.tabs[0]!.title).toBeUndefined()
  })
  it('owner reconciliation removes deleted records and late page updates stay inert', () => {
    const f = fixture(); const id = f.tabs.openTask('task').selectedTabId
    f.valid.delete('task')
    expect(f.tabs.reconcile()).toEqual(['task'])
    expect(f.disk().tasks).toEqual([])
    expect(f.tabs.update('task', id, { title: 'late title' })).toBe(false)
    f.tabs.flush()
    expect(f.disk().tasks).toEqual([])
  })
  it.each(['raw', 'encoded', 'nested'])('omits sensitive %s URLs instead of persisting a changed destination', form => {
    const token = 'ghp_' + 'a'.repeat(36)
    const path = form === 'raw' ? token : (form === 'encoded' ? '%67' : '%2567') + token.slice(1)
    expect(storedBrowserUrl('https://example.com/' + path, redact)).toBeUndefined()
    const f = fixture(); f.deps.redact = redact
    const id = f.tabs.openTask('task').selectedTabId
    f.tabs.beginNavigation('task', id, 'https://example.com/' + path)
    f.tabs.setRemember('task', true)
    expect(f.disk().tasks[0]!.tabs[0]).toEqual({ id })
  })
  it('keeps nonsecret encoded URLs unchanged, strips query/hash first and rejects ambiguous encoding', () => {
    const url = 'https://example.com/%ED%95%9C%EA%B8%80/a%20b/%252F'
    expect(storedBrowserUrl(url, redact)).toBe(url)
    expect(storedBrowserUrl(url + '?token=ghp_' + 'a'.repeat(36) + '#private', redact)).toBe(url)
    for (const path of ['bad%', '%GG', '%FF', '%25252525252525252567']) {
      expect(storedBrowserUrl('https://example.com/' + path, redact)).toBeUndefined()
    }
    expect(storedBrowserUrl('https://example.com/%73ecret', text => text.replace('secret', 'MASKED'))).toBeUndefined()
    let eightPasses = '%67'
    for (let pass = 1; pass < 8; pass++) eightPasses = eightPasses.replaceAll('%', '%25')
    expect(storedBrowserUrl('https://example.com/' + eightPasses, redact)).toBe('https://example.com/' + eightPasses)
    expect(storedBrowserUrl('https://example.com/' + eightPasses.replaceAll('%', '%25'), redact)).toBeUndefined()
  })
  it('redacts full titles before truncation in runtime and disk, and drops oversized source titles', () => {
    const f = fixture(); f.deps.redact = redact
    const id = f.tabs.openTask('task').selectedTabId
    f.tabs.setRemember('task', true)
    f.tabs.update('task', id, { title: 'x'.repeat(270) + 'ghp_' + 'a'.repeat(36) })
    expect(f.tabs.view('task')!.tabs[0]!.title).toContain('가림')
    expect(f.tabs.view('task')!.tabs[0]!.title).not.toContain('ghp_')
    f.tabs.flush()
    expect(JSON.stringify(f.disk())).not.toContain('ghp_')
    f.tabs.update('task', id, { title: 'private prefix' + 'x'.repeat(64 * 1024) })
    expect(f.tabs.view('task')!.tabs[0]!.title).toBe('')
    f.tabs.flush(); expect(f.disk().tasks[0]!.tabs[0]!.title).toBeUndefined()
  })
  it('sanitizes restored tabs with loaded policy before first authorized view and persists before return', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    let disk: BrowserTabsJournal = { tasks: [{ taskId: 'task', remember: true, selectedTabId: id, tabs: [{ id, url: 'https://example.com/late-private', title: 'late-private title' }] }] }
    let loaded = false
    const deps = { id: () => id, validTask: () => loaded, redact: (text: string) => text }
    const journal = { load: () => structuredClone(disk), save: vi.fn((value: BrowserTabsJournal) => { disk = structuredClone(value) }) }
    const tabs = new BrowserTabsStore(journal, deps)
    expect(tabs.view('task')).toBeNull(); expect(journal.save).not.toHaveBeenCalled()
    loaded = true; deps.redact = text => text.replaceAll('late-private', 'MASKED')
    expect(tabs.view('task')!.tabs[0]).toMatchObject({ url: '', title: 'MASKED title' })
    expect(disk.tasks[0]!.tabs[0]).toEqual({ id, title: 'MASKED title' })
    expect(journal.save).toHaveBeenCalledTimes(1)
    tabs.view('task'); expect(journal.save).toHaveBeenCalledTimes(1)
    tabs.beginNavigation('task', id, 'https://example.com/late-private/new-runtime')
    expect(tabs.view('task')!.tabs[0]!.url).toBe('https://example.com/late-private/new-runtime')
    expect(disk.tasks[0]!.tabs[0]!.url).toBeUndefined()
  })
  it('explicit new runtime navigation retires the restore boundary even before first view', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    let disk: BrowserTabsJournal = { tasks: [{ taskId: 'task', remember: true, selectedTabId: id, tabs: [{ id, url: 'https://example.com/saved', title: 'late-private title' }] }] }
    let loaded = false
    const deps = { id: () => id, validTask: () => loaded, redact: (text: string) => text }
    const tabs = new BrowserTabsStore({ load: () => structuredClone(disk), save: value => { disk = structuredClone(value) } }, deps)
    loaded = true; deps.redact = text => text.replaceAll('late-private', 'MASKED')
    tabs.beginNavigation('task', id, 'https://example.com/late-private/new-runtime')
    expect(tabs.view('task')!.tabs[0]).toMatchObject({ url: 'https://example.com/late-private/new-runtime', title: 'MASKED title' })
    expect(disk.tasks[0]!.tabs[0]!.url).toBeUndefined()
  })
  it('returns no restored address when policy sanitization cannot be durably saved', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    const saved: BrowserTabsJournal = { tasks: [{ taskId: 'task', remember: true, selectedTabId: id, tabs: [{ id, url: 'https://example.com/late-private' }] }] }
    let loaded = false
    const deps = { id: () => id, validTask: () => loaded, redact: (text: string) => text }
    const tabs = new BrowserTabsStore({ load: () => structuredClone(saved), save: () => { throw new Error('disk failure') } }, deps)
    loaded = true; deps.redact = text => text.replaceAll('late-private', 'MASKED')
    expect(() => tabs.view('task')).toThrow('disk failure')
    expect(tabs.failureReason).toBe('disk failure')
    expect(() => tabs.view('task')).toThrow()
  })
})
