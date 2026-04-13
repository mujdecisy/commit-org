import { useState, useCallback } from 'react'
import type { FileStatus, CommitEntry, StatusResult } from '../../preload/index.d'

// ── helpers ──────────────────────────────────────────────────────────────────

function localDatetimeNow(): string {
  const d = new Date()
  d.setSeconds(0, 0)
  return d.toISOString().slice(0, 16)
}

function statusLabel(f: FileStatus): string {
  const c = f.index !== ' ' && f.index !== '?' ? f.index : f.working_dir
  const map: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', '?': 'U' }
  return map[c] ?? c
}

function statusColor(label: string): string {
  const map: Record<string, string> = { M: '#e5c07b', A: '#98c379', D: '#e06c75', R: '#61afef', U: '#56b6c2' }
  return map[label] ?? '#abb2bf'
}

// ── DiffViewer ────────────────────────────────────────────────────────────────

function DiffViewer({ diff, file }: { diff: string; file: string }) {
  if (!diff.trim())
    return (
      <div className="diff-empty">
        <span>No diff available</span>
      </div>
    )

  const lines = diff.split('\n')
  return (
    <div className="diff-viewer">
      <div className="diff-file-header">{file}</div>
      <pre className="diff-body">
        {lines.map((line, i) => {
          let cls = 'diff-line'
          if (line.startsWith('+') && !line.startsWith('+++')) cls += ' diff-add'
          else if (line.startsWith('-') && !line.startsWith('---')) cls += ' diff-remove'
          else if (line.startsWith('@@')) cls += ' diff-hunk'
          else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) cls += ' diff-meta'
          return (
            <div key={i} className={cls}>
              {line || ' '}
            </div>
          )
        })}
      </pre>
    </div>
  )
}

// ── CommitPanel ───────────────────────────────────────────────────────────────

interface CommitPanelProps {
  repoPath: string
  selectedFiles: Set<string>
  onCommitted: () => void
}

function CommitPanel({ repoPath, selectedFiles, onCommitted }: CommitPanelProps) {
  const [message, setMessage] = useState('')
  const [date, setDate] = useState(localDatetimeNow)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const commit = async () => {
    if (!message.trim()) { setError('Commit message is required'); return }
    if (selectedFiles.size === 0) { setError('No files selected'); return }
    setBusy(true)
    setError('')
    try {
      await window.git.createCommit(repoPath, {
        message: message.trim(),
        date: new Date(date).toISOString(),
        files: [...selectedFiles]
      })
      setMessage('')
      setDate(localDatetimeNow())
      onCommitted()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="commit-panel">
      <div className="panel-section">
        <label className="field-label">Commit message</label>
        <textarea
          className="commit-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Describe your changes…"
          rows={4}
        />
      </div>
      <div className="panel-section">
        <label className="field-label">Date &amp; time</label>
        <input
          type="datetime-local"
          className="date-input"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      <div className="panel-section">
        <div className="selected-count">
          {selectedFiles.size} file{selectedFiles.size !== 1 ? 's' : ''} selected
        </div>
      </div>
      {error && <div className="error-msg">{error}</div>}
      <button
        className="commit-btn"
        onClick={commit}
        disabled={busy || selectedFiles.size === 0 || !message.trim()}
      >
        {busy ? 'Committing…' : 'Commit'}
      </button>
    </div>
  )
}

// ── HistoryPanel ──────────────────────────────────────────────────────────────

interface HistoryPanelProps {
  repoPath: string
  log: CommitEntry[]
  onReset: () => void
}

function HistoryPanel({ repoPath, log, onReset }: HistoryPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = async (hash: string, mode: string) => {
    setBusy(true)
    try {
      await window.git.resetToCommit(repoPath, hash, mode)
      onReset()
      setExpanded(null)
    } catch (e) {
      alert(`Reset failed: ${e}`)
    } finally {
      setBusy(false)
    }
  }

  if (log.length === 0)
    return <div className="diff-empty"><span>No commits yet</span></div>

  return (
    <div className="history-list">
      {log.map((entry) => (
        <div key={entry.hash} className="history-entry">
          <div
            className="history-header"
            onClick={() => setExpanded(expanded === entry.hash ? null : entry.hash)}
          >
            <span className="history-hash">{entry.hashShort}</span>
            <span className="history-msg">{entry.message}</span>
            <span className="history-date">{entry.date}</span>
          </div>
          {expanded === entry.hash && (
            <div className="history-actions">
              <span className="history-author">{entry.author}</span>
              <div className="reset-buttons">
                <button
                  className="reset-btn soft"
                  disabled={busy}
                  onClick={() => reset(entry.hash, 'soft')}
                >
                  Reset soft
                </button>
                <button
                  className="reset-btn mixed"
                  disabled={busy}
                  onClick={() => reset(entry.hash, 'mixed')}
                >
                  Reset mixed
                </button>
                <button
                  className="reset-btn hard"
                  disabled={busy}
                  onClick={() => reset(entry.hash, 'hard')}
                >
                  Reset hard
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [repoPath, setRepoPath] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusResult | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [activeDiff, setActiveDiff] = useState<{ file: string; content: string } | null>(null)
  const [log, setLog] = useState<CommitEntry[]>([])
  const [rightTab, setRightTab] = useState<'commit' | 'history'>('commit')
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (path: string) => {
    setLoading(true)
    try {
      const [s, l] = await Promise.all([window.git.getStatus(path), window.git.getLog(path)])
      setStatus(s)
      setLog(l)
      setSelectedFiles(new Set(s.files.map((f) => f.path)))
      setActiveDiff(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const openProject = async () => {
    const path = await window.git.openProject()
    if (!path) return
    setRepoPath(path)
    await refresh(path)
  }

  const showDiff = async (file: string) => {
    if (!repoPath) return
    const content = await window.git.getDiff(repoPath, file)
    setActiveDiff({ file, content })
  }

  const toggleFile = (path: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleAll = () => {
    if (!status) return
    if (selectedFiles.size === status.files.length) {
      setSelectedFiles(new Set())
    } else {
      setSelectedFiles(new Set(status.files.map((f) => f.path)))
    }
  }

  const files = status?.files ?? []

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <button className="open-btn" onClick={openProject}>
          Open Project
        </button>
        {repoPath && (
          <>
            <span className="repo-path">{repoPath}</span>
            {status?.branch && <span className="branch-badge">{status.branch}</span>}
          </>
        )}
        {loading && <span className="loading-dot">●</span>}
      </header>

      {!repoPath ? (
        <div className="empty-state">
          <div className="empty-icon">⎇</div>
          <div className="empty-title">Open a git project to get started</div>
          <button className="open-btn large" onClick={openProject}>
            Open Project
          </button>
        </div>
      ) : (
        <div className="workspace">
          {/* Left: file list */}
          <aside className="sidebar">
            <div className="sidebar-header">
              <span>Changes ({files.length})</span>
              {files.length > 0 && (
                <button className="link-btn" onClick={toggleAll}>
                  {selectedFiles.size === files.length ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>
            {files.length === 0 ? (
              <div className="no-changes">No changes</div>
            ) : (
              <ul className="file-list">
                {files.map((f) => {
                  const label = statusLabel(f)
                  const isActive = activeDiff?.file === f.path
                  return (
                    <li
                      key={f.path}
                      className={`file-item${isActive ? ' active' : ''}`}
                      onClick={() => showDiff(f.path)}
                    >
                      <input
                        type="checkbox"
                        checked={selectedFiles.has(f.path)}
                        onChange={() => toggleFile(f.path)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span className="file-status" style={{ color: statusColor(label) }}>
                        {label}
                      </span>
                      <span className="file-name" title={f.path}>
                        {f.path}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="sidebar-footer">
              <button
                className="refresh-btn"
                onClick={() => repoPath && refresh(repoPath)}
                disabled={loading}
              >
                ↺ Refresh
              </button>
            </div>
          </aside>

          {/* Center: diff viewer */}
          <main className="diff-area">
            {activeDiff ? (
              <DiffViewer diff={activeDiff.content} file={activeDiff.file} />
            ) : (
              <div className="diff-empty">
                <span>Select a file to view diff</span>
              </div>
            )}
          </main>

          {/* Right: commit / history */}
          <aside className="right-panel">
            <div className="tab-bar">
              <button
                className={`tab-btn${rightTab === 'commit' ? ' active' : ''}`}
                onClick={() => setRightTab('commit')}
              >
                Commit
              </button>
              <button
                className={`tab-btn${rightTab === 'history' ? ' active' : ''}`}
                onClick={() => setRightTab('history')}
              >
                History
              </button>
            </div>
            {rightTab === 'commit' ? (
              <CommitPanel
                repoPath={repoPath}
                selectedFiles={selectedFiles}
                onCommitted={() => refresh(repoPath)}
              />
            ) : (
              <HistoryPanel
                repoPath={repoPath}
                log={log}
                onReset={() => refresh(repoPath)}
              />
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
