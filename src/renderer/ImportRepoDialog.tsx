// 70단계: 저장소째 가져오기 — 폴더 고르기(main 대화상자) → 미리보기(읽기만) → 고른 것만 → 누를 때 다시 읽고 한 동작으로 일감을 만든다.
// 닫으면 그 뒤에 온 답은 버리고 만들지 않는다. 세션은 '이어 하기 후보' 로만 붙이고 시작하지 않는다.
import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { AgentIcon } from './AgentIcon'
import { AGENT_NAME } from '../shared/chat'
import { sessionAgo } from '../shared/agent-sessions'
import { MERGE_LABEL } from '../shared/worktree-cleanup'
import type { NewId } from '../shared/model'
import {
  importable, importGroup, pickedByDefault, runImport,
  type ImportPreview, type ImportReport, type ImportRow, type RepoImportApi,
} from '../shared/repo-import'
import type { AppState, Group, Task } from '../shared/types'
import './repo-import.css'

interface Props {
  /** 워크트리 패널에서 열면 그 일감 폴더 — 없으면 열자마자 폴더 고르기 */
  root?: string
  api?: RepoImportApi
  /** 지금 상태 — 묶음 이름 · 같은 폴더 일감은 누를 때 다시 본다 */
  state(): AppState
  newId: NewId
  /** reducer `task/import` 한 동작 */
  onApply(tasks: Task[], group: Group | null): void
  onClose(): void
}

type Phase =
  | { kind: 'picking' }
  | { kind: 'reading'; root: string }
  | { kind: 'error'; root: string | null; message: string }
  // source = 그 미리보기를 읽은 폴더(고른 폴더 · 패널의 일감 폴더) — 다시 읽기 · 가져오기도 이 폴더로(main 권한 목록에 있는 것은 이 경로다)
  | { kind: 'ready'; preview: ImportPreview; source: string; error?: string }
  | { kind: 'running'; preview: ImportPreview; source: string }
  | { kind: 'done'; preview: ImportPreview; source: string; report: ImportReport }

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : '저장소를 읽지 못했어요')

export function ImportRepoDialog({ root, api = window.taskminal.repoImport, state, newId, onApply, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>(root ? { kind: 'reading', root } : { kind: 'picking' })
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  // 세대 — 읽기 · 고르기 · 닫기마다 올린다. 앞 세대의 답 · 닫힌 뒤의 답은 버린다(옛 응답)
  const gen = useRef(0)
  const mounted = useRef(false)
  const started = useRef(false)
  const live = (g: number) => mounted.current && gen.current === g
  const lock = useRef(false)
  const shown = useRef<{ preview: ImportPreview; source: string } | null>(null)
  const now = Date.now()
  const heading = useRef<HTMLHeadingElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)

  const read = (target: string) => {
    const g = ++gen.current
    setPhase({ kind: 'reading', root: target })
    api.preview(target).then(
      (preview) => {
        if (!live(g)) return
        shown.current = { preview, source: target }
        setPicked(new Set(preview.rows.filter(pickedByDefault).map((r) => r.path)))
        setPhase({ kind: 'ready', preview, source: target })
      },
      (e: unknown) => { if (live(g)) setPhase({ kind: 'error', root: target, message: message(e) }) },
    )
  }
  const pick = () => {
    const g = ++gen.current
    setPhase({ kind: 'picking' })
    api.pick().then(
      (folder) => {
        if (!live(g)) return
        if (folder) return read(folder)
        // 고르기 취소 — 보던 미리보기로, 없으면 닫는다
        if (shown.current) setPhase({ kind: 'ready', ...shown.current })
        else onClose()
      },
      (e: unknown) => { if (live(g)) setPhase({ kind: 'error', root: null, message: message(e) }) },
    )
  }

  useEffect(() => {
    mounted.current = true
    // 처음 한 번 — StrictMode 의 두 번 실행에도 고르기 대화상자는 하나(root 가 바뀌면 App 이 새로 연다)
    if (!started.current) {
      started.current = true
      if (root) read(root)
      else pick()
    }
    return () => { mounted.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 포커스는 늘 대화상자 안 — 끝나면 닫기, 그 밖(읽는 중 · 가져오는 중에 단추가 꺼져도)은 제목
  useEffect(() => {
    if (phase.kind === 'done') doneRef.current?.focus()
    else heading.current?.focus()
  }, [phase.kind])

  const run = () => {
    if (lock.current || phase.kind !== 'ready') return
    const { preview, source } = phase
    const picks = preview.rows.filter((r) => picked.has(r.path) && importable(r)).map((r) => ({ path: r.path, commonDir: r.commonDir, label: r.label }))
    if (!picks.length) return
    lock.current = true
    const g = gen.current
    setPhase({ kind: 'running', preview, source })
    runImport(source, picks, { preview: api.preview, state, newId, now: Date.now, alive: () => live(g), apply: onApply })
      .then(
        (report) => { if (report && live(g)) setPhase({ kind: 'done', preview, source, report }) },
        (e: unknown) => { if (live(g)) setPhase({ kind: 'ready', preview, source, error: `다시 확인하지 못해 아무 일감도 만들지 않았어요 — ${message(e)}` }) },
      )
      .finally(() => { lock.current = false })
  }

  const close = () => { gen.current++; onClose() }
  const preview = phase.kind === 'ready' || phase.kind === 'running' || phase.kind === 'done' ? phase.preview : null
  const rows = preview?.rows ?? []
  const count = rows.filter((r) => picked.has(r.path) && importable(r)).length
  const target = preview ? (() => {
    const s = state()
    const g = importGroup(s, preview.repo, rows.map((r) => r.path), preview.home)
    return 'create' in g ? `새 묶음 ‘${g.create}’` : `있는 묶음 ‘${s.settings.groups.find((x) => x.id === g.reuse)?.name ?? preview.repo}’`
  })() : ''
  const busy = phase.kind === 'picking' || phase.kind === 'reading' || phase.kind === 'running'
  const toggle = (path: string) => setPicked((old) => { const next = new Set(old); if (next.has(path)) next.delete(path); else next.add(path); return next })

  return (
    <Modal role="dialog" labelledBy="repo-import-title" className="wide repo-import" onCancel={close}>
      <h1 id="repo-import-title" ref={heading} tabIndex={-1}>저장소째 가져오기</h1>
      <p className="repo-import-meta">
        저장소의 worktree 마다 일감을 만들고 저장소 이름 묶음에 넣어요. 그 폴더에서 하던 Claude · Codex 세션은 일감의 ‘이어 하기’ 후보로만 붙이고 시작하지 않아요.
      </p>
      <div role="status" className="repo-import-meta">
        {phase.kind === 'picking' ? '저장소 폴더를 고르는 중…'
          : phase.kind === 'reading' ? '저장소를 읽는 중…'
          : phase.kind === 'running' ? '다시 확인하고 일감을 만드는 중… 지금 닫으면 만들지 않아요.'
          : phase.kind === 'done' ? `${phase.report.created.length}개 일감을 만들었어요${phase.report.group ? ` — 묶음 ‘${phase.report.group}’` : ''}${phase.report.skipped.length ? ` · ${phase.report.skipped.length}개는 건너뛰었어요` : ''}`
          : ''}
      </div>
      {phase.kind === 'error' && <p role="alert" className="repo-import-error">{phase.message}</p>}
      {phase.kind === 'ready' && phase.error && <p role="alert" className="repo-import-error">{phase.error}</p>}
      {preview && phase.kind !== 'done' && <>
        <p className="repo-import-meta repo-import-path">저장소: {preview.root} · worktree {rows.length}개 · {target}에 넣어요</p>
        {preview.sessionsNote && <p className="repo-import-meta">{preview.sessionsNote}</p>}
        <fieldset className="repo-import-list" disabled={phase.kind !== 'ready'}>
          <legend>가져올 worktree 고르기</legend>
          {rows.map((r) => <ImportRowView key={r.path} row={r} checked={picked.has(r.path) && importable(r)} now={now} onToggle={() => toggle(r.path)} />)}
        </fieldset>
      </>}
      {phase.kind === 'done' && <section className="repo-import-report" aria-label="가져오기 결과">
        {!!phase.report.created.length && <ul>{phase.report.created.map((c) => <li key={c.taskId}><strong>{c.name}</strong> · <span className="repo-import-path">{c.path}</span>{c.hints ? ` · 이어 하기 후보 ${c.hints}개` : ''}</li>)}</ul>}
        {!!phase.report.skipped.length && <ul className="repo-import-skipped">{phase.report.skipped.map((s) => <li key={s.path}><strong>{s.label}</strong> · <span className="repo-import-path">{s.path}</span> — {s.reason}</li>)}</ul>}
      </section>}
      <footer className="dialog-actions">
        {phase.kind === 'done' ? (
          <button ref={doneRef} type="button" className="button primary" onClick={close}>닫기</button>
        ) : <>
          <button type="button" className="button" disabled={phase.kind === 'running'} onClick={pick}>다른 저장소…</button>
          {(preview || (phase.kind === 'error' && phase.root)) && <button type="button" className="button" disabled={phase.kind === 'running'} onClick={() => read(phase.kind === 'error' ? phase.root! : phase.kind === 'ready' ? phase.source : '')}>다시 읽기</button>}
          <button type="button" className="button" onClick={close}>닫기</button>
          <button type="button" className="button primary" disabled={busy || phase.kind !== 'ready' || count === 0} onClick={run}>고른 {count}개 가져오기</button>
        </>}
      </footer>
    </Modal>
  )
}

function ImportRowView({ row, checked, now, onToggle }: { row: ImportRow; checked: boolean; now: number; onToggle(): void }) {
  const merge = row.merge && MERGE_LABEL[row.merge.state]
  return (
    <label className={`repo-import-row${importable(row) ? '' : ' off'}`}>
      <input type="checkbox" checked={checked} disabled={!importable(row)} onChange={onToggle} />
      <span className="repo-import-text">
        <span className="repo-import-head">
          <strong>{row.label}</strong>
          {row.primary && <span className="repo-import-chip">기본</span>}
          {row.locked && <span className="repo-import-chip">잠김</span>}
          {merge && <span className={`repo-import-chip ${row.merge!.state}`} title={row.merge!.reason}>{merge}</span>}
        </span>
        <span className="repo-import-path">{row.path}</span>
        {row.existing ? <span className="repo-import-meta">이미 일감 있음 — {row.existing.name}</span>
          : row.blocked ? <span className="repo-import-meta">가져올 수 없어요 — {row.blocked}</span>
          : row.sessions.length ? <span className="repo-import-meta">이어 하기 후보: {row.sessions.map((h) => (
            <span key={h.id} className="repo-import-session"><AgentIcon agent={h.agent} size={12} />{AGENT_NAME[h.agent]} · {h.summary || '(첫 글 없음)'} · {sessionAgo(h.at, now)}</span>
          ))}</span>
          : <span className="repo-import-meta">이 폴더의 세션 없음</span>}
      </span>
    </label>
  )
}
