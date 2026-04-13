import { useState, useCallback, useEffect } from 'react'
import type { FileStatus, CommitEntry, StatusResult, UpstreamInfo } from '../../preload/index.d'
import { version } from '../../../package.json'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Hunk {
  id: string        // `${filePath}::${index}`
  header: string    // the @@ line
  lines: string[]   // all lines in this hunk
  filePath: string
  fileHeader: string // "--- a/...\n+++ b/..."
}

// file is either fully selected, partially (some hunks), or deselected
type FileMode = 'full' | 'partial' | 'none'

interface TreeNode {
  name: string
  children: Map<string, TreeNode>
  isFile: boolean
}

interface TreeItem {
  path: string
  display: string
  indent: number
  isFile: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const map: Record<string, string> = {
    M: '#b07d00', A: '#1a7f3c', D: '#c0392b', R: '#2f6db5', U: '#5b4de8'
  }
  return map[label] ?? '#8e8e93'
}

/** Parse a unified diff string into Hunk objects */
function parseHunks(filePath: string, diff: string): Hunk[] {
  const lines = diff.split('\n')
  const hunks: Hunk[] = []
  let fileHeader = ''
  let current: string[] | null = null
  let hunkHeader = ''

  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      fileHeader += line + '\n'
    } else if (line.startsWith('@@')) {
      if (current !== null) {
        hunks.push({
          id: `${filePath}::${hunks.length}`,
          header: hunkHeader,
          lines: current,
          filePath,
          fileHeader
        })
      }
      hunkHeader = line
      current = []
    } else if (current !== null) {
      current.push(line)
    }
  }

  if (current !== null && (current.length > 0 || hunkHeader)) {
    hunks.push({
      id: `${filePath}::${hunks.length}`,
      header: hunkHeader,
      lines: current,
      filePath,
      fileHeader
    })
  }

  return hunks
}

/** Build a minimal patch string from selected hunks */
function buildPatch(hunks: Hunk[]): string {
  if (hunks.length === 0) return ''
  const fileHeader = hunks[0].fileHeader
  const body = hunks.map((h) => `${h.header}\n${h.lines.join('\n')}`).join('\n')
  return `${fileHeader}${body}\n`
}

/** Build a tree structure from file paths */
function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', children: new Map(), isFile: false }
  for (const path of paths) {
    const parts = path.split('/')
    let current = root
    for (const part of parts) {
      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map(), isFile: false })
      }
      current = current.children.get(part)!
    }
    current.isFile = true
  }
  return root
}

/** Collect all folder paths from tree */
function collectFolders(node: TreeNode, prefix: string, folders: Set<string>) {
  for (const [name, child] of node.children) {
    if (!child.isFile) {
      const folderPath = prefix + name + '/'
      folders.add(folderPath)
      collectFolders(child, folderPath, folders)
    }
  }
}

// ── DiffViewer ────────────────────────────────────────────────────────────────

interface DiffViewerProps {
  filePath: string
  diff: string
  fileMode: FileMode
  selectedHunkIds: Set<string>
  onToggleFile: () => void
  onToggleHunk: (id: string) => void
}

function DiffViewer({
  filePath,
  diff,
  fileMode,
  selectedHunkIds,
  onToggleFile,
  onToggleHunk
}: DiffViewerProps) {
  const hunks = parseHunks(filePath, diff)
  const hasHunks = hunks.length > 0

  if (!diff.trim()) {
    return <div className="diff-empty"><span>No diff available</span></div>
  }

  return (
    <div className="diff-viewer">
      <div className="diff-file-header">
        <label className="hunk-check-label" title="Toggle whole file">
          <input
            type="checkbox"
            checked={fileMode !== 'none'}
            ref={(el) => { if (el) el.indeterminate = fileMode === 'partial' }}
            onChange={onToggleFile}
          />n 
          <span className="diff-file-name">{filePath}</span>
        </label>
        {hasHunks && (
          <span className="hunk-count">{selectedHunkIds.size}/{hunks.length} hunks</span>
        )}
      </div>

      <pre className="diff-body">
        {hasHunks ? hunks.map((hunk) => (
          <div key={hunk.id} className="hunk-block">
            <div className={`hunk-header-row${selectedHunkIds.has(hunk.id) ? ' selected' : ''}`}>
              <label className="hunk-check-label">
                <input
                  type="checkbox"
                  checked={selectedHunkIds.has(hunk.id)}
                  onChange={() => onToggleHunk(hunk.id)}
                />
                <span className="diff-hunk">{hunk.header}</span>
              </label>
            </div>
            {hunk.lines.map((line, i) => {
              let cls = 'diff-line'
              if (line.startsWith('+')) cls += ' diff-add'
              else if (line.startsWith('-')) cls += ' diff-remove'
              return (
                <div key={i} className={cls}>{line || ' '}</div>
              )
            })}
          </div>
        )) : (
          // No parsed hunks — render raw diff lines
          diff.split('\n').map((line, i) => {
            let cls = 'diff-line'
            if (line.startsWith('+') && !line.startsWith('+++')) cls += ' diff-add'
            else if (line.startsWith('-') && !line.startsWith('---')) cls += ' diff-remove'
            else if (line.startsWith('@@')) cls += ' diff-hunk'
            else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) cls += ' diff-meta'
            return <div key={i} className={cls}>{line || ' '}</div>
          })
        )}
      </pre>
    </div>
  )
}

// ── CommitPanel ───────────────────────────────────────────────────────────────

interface CommitPanelProps {
  repoPath: string
  wholeFiles: string[]
  hunkPatches: string[]
  totalCount: number
  onCommitted: () => void
}

function CommitPanel({ repoPath, wholeFiles, hunkPatches, totalCount, onCommitted }: CommitPanelProps) {
  const [message, setMessage] = useState('')
  const [date, setDate] = useState(localDatetimeNow)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const commit = async () => {
    if (!message.trim()) { setError('Commit message is required'); return }
    if (totalCount === 0) { setError('Nothing selected'); return }
    setBusy(true)
    setError('')
    try {
      await window.git.createCommit(repoPath, {
        message: message.trim(),
        date: new Date(date).toISOString(),
        files: wholeFiles,
        patches: hunkPatches
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
          {wholeFiles.length > 0 && <span>{wholeFiles.length} whole file{wholeFiles.length !== 1 ? 's' : ''}</span>}
          {wholeFiles.length > 0 && hunkPatches.length > 0 && <span> · </span>}
          {hunkPatches.length > 0 && <span>{hunkPatches.length} partial file{hunkPatches.length !== 1 ? 's' : ''}</span>}
          {totalCount === 0 && <span>Nothing selected</span>}
        </div>
      </div>
      {error && <div className="error-msg">{error}</div>}
      <button
        className="commit-btn"
        onClick={commit}
        disabled={busy || totalCount === 0 || !message.trim()}
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
  logError: string | null
  onReset: () => void
}

function HistoryPanel({ repoPath, log, logError, onReset }: HistoryPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [upstream, setUpstream] = useState<UpstreamInfo | null>(null)

  useEffect(() => {
    globalThis.window.git.getUpstreamInfo(repoPath).then(setUpstream)
  }, [repoPath, log])

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

  const resetToUpstream = async (mode: string) => {
    setBusy(true)
    try {
      await window.git.resetToUpstream(repoPath, mode)
      onReset()
    } catch (e) {
      alert(`Reset failed: ${e}`)
    } finally {
      setBusy(false)
    }
  }

  if (logError) {
    return (
      <div className="history-error">
        <div className="history-error-title">Could not load history</div>
        <pre className="history-error-detail">{logError}</pre>
      </div>
    )
  }

  if (log.length === 0) {
    return <div className="diff-empty"><span>No commits yet</span></div>
  }

  return (
    <div className="history-list">
      {upstream?.upstream && (
        <div className="upstream-section">
          <div className="upstream-info">
            <span className="upstream-label">Upstream</span>
            <span className="upstream-name">{upstream.upstream}</span>
            {upstream.behind > 0 && (
              <span className="upstream-behind">{upstream.behind} behind</span>
            )}
            {upstream.behind === 0 && (
              <span className="upstream-uptodate">up to date</span>
            )}
          </div>
          <div className="reset-buttons">
            <button className="reset-btn soft" disabled={busy} onClick={() => resetToUpstream('soft')}>
              Reset soft
            </button>
            <button className="reset-btn mixed" disabled={busy} onClick={() => resetToUpstream('mixed')}>
              Reset mixed
            </button>
            <button className="reset-btn hard" disabled={busy} onClick={() => resetToUpstream('hard')}>
              Reset hard
            </button>
          </div>
        </div>
      )}
      {upstream?.error && !upstream.upstream && (
        <div className="upstream-section upstream-error">{upstream.error}</div>
      )}
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
                <button className="reset-btn soft" disabled={busy} onClick={() => reset(entry.hash, 'soft')}>
                  Reset soft
                </button>
                <button className="reset-btn mixed" disabled={busy} onClick={() => reset(entry.hash, 'mixed')}>
                  Reset mixed
                </button>
                <button className="reset-btn hard" disabled={busy} onClick={() => reset(entry.hash, 'hard')}>
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
  const [log, setLog] = useState<CommitEntry[]>([])
  const [rightTab, setRightTab] = useState<'commit' | 'history'>('commit')
  const [loading, setLoading] = useState(false)
  const [disclaimerDismissed, setDisclaimerDismissed] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)

  // active diff state
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [activeDiff, setActiveDiff] = useState<string>('')

  // selection: per-file mode and per-hunk ids
  // fileModes: filePath → 'full' | 'partial' | 'none'
  const [fileModes, setFileModes] = useState<Map<string, FileMode>>(new Map())
  // selectedHunks: hunkId → Hunk (kept for patch building)
  const [selectedHunks, setSelectedHunks] = useState<Map<string, Hunk>>(new Map())
  // parsed hunks per file (populated when diff is loaded)
  const [fileHunks, setFileHunks] = useState<Map<string, Hunk[]>>(new Map())

  // expanded folders
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())

  const refresh = useCallback(async (path: string) => {
    setLoading(true)
    try {
      const [s, l] = await Promise.all([window.git.getStatus(path), window.git.getLog(path)])
      setStatus(s)
      if (Array.isArray(l)) {
        setLog(l)
        setLogError(null)
      } else {
        setLog([])
        setLogError(l.error)
      }
      // default: all files fully selected
      const modes = new Map<string, FileMode>()
      s.files.forEach((f) => modes.set(f.path, 'full'))
      setFileModes(modes)
      setSelectedHunks(new Map())
      setFileHunks(new Map())
      setActiveFile(null)
      setActiveDiff('')
      // expand all folders
      const tree = buildTree(s.files.map(f => f.path))
      const allFolders = new Set<string>()
      collectFolders(tree, '', allFolders)
      setExpandedFolders(allFolders)
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

  const showDiff = async (filePath: string) => {
    if (!repoPath) return
    setActiveFile(filePath)
    const diff = await window.git.getDiff(repoPath, filePath)
    setActiveDiff(diff)
    // parse and cache hunks
    const hunks = parseHunks(filePath, diff)
    setFileHunks((prev) => new Map(prev).set(filePath, hunks))
  }

  // Toggle whole file: full ↔ none (clears any partial hunk state)
  const toggleFile = (filePath: string) => {
    setFileModes((prev) => {
      const next = new Map(prev)
      const current = next.get(filePath) ?? 'none'
      next.set(filePath, current === 'none' ? 'full' : 'none')
      return next
    })
    // clear hunk selections for this file
    setSelectedHunks((prev) => {
      const next = new Map(prev)
      for (const [id] of prev) {
        if (id.startsWith(`${filePath}::`)) next.delete(id)
      }
      return next
    })
  }

  // Toggle a single hunk — switches file to 'partial' mode
  const toggleHunk = (filePath: string, hunkId: string) => {
    const hunks = fileHunks.get(filePath) ?? []

    setSelectedHunks((prev) => {
      const next = new Map(prev)
      if (next.has(hunkId)) {
        next.delete(hunkId)
      } else {
        const hunk = hunks.find((h) => h.id === hunkId)
        if (hunk) next.set(hunkId, hunk)
      }
      // recompute file mode
      const fileHunkIds = hunks.map((h) => h.id)
      const selectedCount = fileHunkIds.filter((id) => next.has(id)).length
      setFileModes((pm) => {
        const nm = new Map(pm)
        if (selectedCount === 0) nm.set(filePath, 'none')
        else if (selectedCount === fileHunkIds.length) nm.set(filePath, 'full')
        else nm.set(filePath, 'partial')
        return nm
      })
      return next
    })
  }

  // Toggle file from diff header (cycle: none → full → none, or partial → full → none)
  const toggleFileFromDiff = (filePath: string) => {
    const mode = fileModes.get(filePath) ?? 'none'
    const hunks = fileHunks.get(filePath) ?? []

    if (mode === 'full') {
      // deselect everything
      setFileModes((prev) => new Map(prev).set(filePath, 'none'))
      setSelectedHunks((prev) => {
        const next = new Map(prev)
        for (const [id] of prev) {
          if (id.startsWith(`${filePath}::`)) next.delete(id)
        }
        return next
      })
    } else {
      // select all hunks → full
      setFileModes((prev) => new Map(prev).set(filePath, 'full'))
      setSelectedHunks((prev) => {
        const next = new Map(prev)
        // clear partial hunks for this file first
        for (const [id] of prev) {
          if (id.startsWith(`${filePath}::`)) next.delete(id)
        }
        // if we had hunks loaded, add them (not strictly needed since 'full' = stage whole file)
        hunks.forEach((h) => next.set(h.id, h))
        return next
      })
    }
  }

  const selectAll = () => {
    if (!status) return
    const modes = new Map<string, FileMode>()
    status.files.forEach((f) => modes.set(f.path, 'full'))
    setFileModes(modes)
    setSelectedHunks(new Map())
  }

  const deselectAll = () => {
    if (!status) return
    const modes = new Map<string, FileMode>()
    status.files.forEach((f) => modes.set(f.path, 'none'))
    setFileModes(modes)
    setSelectedHunks(new Map())
  }

  const allSelected = status?.files.every((f) => fileModes.get(f.path) === 'full') ?? false

  const toggleFolder = (folderPath: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folderPath)) {
        next.delete(folderPath)
      } else {
        next.add(folderPath)
      }
      return next
    })
  }

  // Build commit args
  const wholeFiles = (status?.files ?? [])
    .filter((f) => fileModes.get(f.path) === 'full')
    .map((f) => f.path)

  // For partial files, group selected hunks by file and build patches
  const partialFiles = (status?.files ?? []).filter((f) => fileModes.get(f.path) === 'partial')
  const hunkPatches = partialFiles.map((f) => {
    const hunks = [...selectedHunks.values()].filter((h) => h.filePath === f.path)
    return buildPatch(hunks)
  }).filter(Boolean)

  const totalCount = wholeFiles.length + hunkPatches.length

  const files = status?.files ?? []

  // Build tree items for display
  const tree = buildTree(files.map(f => f.path))
  const treeItems: TreeItem[] = []
  function traverse(node: TreeNode, prefix: string, indent: number, expanded: Set<string>) {
    const sorted = Array.from(node.children.entries()).sort(([a], [b]) => {
      const aIsFile = node.children.get(a)!.isFile
      const bIsFile = node.children.get(b)!.isFile
      if (aIsFile !== bIsFile) return aIsFile ? 1 : -1
      return a.localeCompare(b)
    })
    for (const [name, child] of sorted) {
      if (child.isFile) {
        treeItems.push({ path: prefix + name, display: name, indent, isFile: true })
      } else {
        const folderPath = prefix + name + '/'
        treeItems.push({ path: folderPath, display: name + '/', indent, isFile: false })
        if (expanded.has(folderPath)) {
          traverse(child, folderPath, indent + 1, expanded)
        }
      }
    }
  }
  traverse(tree, '', 0, expandedFolders)

  return (
    <div className="app">
      <header className="header">
        <button className="open-btn" onClick={openProject}>Open Project</button>
        {repoPath && (
          <span className="repo-path">{repoPath}</span>
        )}
        {loading && <span className="loading-dot">●</span>}
        {status?.branch && (
          <span className="branch-display">
            <span className="branch-icon">⎇</span>
            {status.branch}
          </span>
        )}
      </header>

      {!disclaimerDismissed && (
        <div className="disclaimer-banner">
          <span className="disclaimer-icon">⚠</span>
          <span className="disclaimer-text">
            This tool is only for commit rearrangement. Switch to the correct branch before, and do the push operations after, in your current VCS tools.
          </span>
          <button className="disclaimer-close" onClick={() => setDisclaimerDismissed(true)}>✕</button>
        </div>
      )}

      {!repoPath ? (
        <div className="empty-state">
          <div className="empty-icon">⎇</div>
          <div className="empty-title">Open a git project to get started</div>
          <button className="open-btn large" onClick={openProject}>Open Project</button>
        </div>
      ) : (
        <div className="workspace">
          {/* Left: file list */}
          <aside className="sidebar" style={{ paddingLeft: '10px' }}>
            <div className="sidebar-header">
              <span>Changes ({files.length})</span>
              {files.length > 0 && (
                <button className="link-btn" onClick={allSelected ? deselectAll : selectAll}>
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>
            {files.length === 0 ? (
              <div className="no-changes">No changes</div>
            ) : (
              <ul className="file-list">
                {treeItems.map((item) => {
                  if (!item.isFile) {
                    const isExpanded = expandedFolders.has(item.path)
                    return (
                      <li
                        key={item.path}
                        className="file-item folder"
                        style={{ paddingLeft: `${item.indent * 20}px` }}
                        onClick={() => toggleFolder(item.path)}
                      >
                        <span className="folder-icon">{isExpanded ? '▼' : '▶'}</span>
                        <span className="file-name">{item.display}</span>
                      </li>
                    )
                  }
                  const f = files.find(ff => ff.path === item.path)!
                  const label = statusLabel(f)
                  const mode = fileModes.get(f.path) ?? 'none'
                  const isActive = activeFile === f.path
                  return (
                    <li
                      key={f.path}
                      className={`file-item${isActive ? ' active' : ''}`}
                      onClick={() => showDiff(f.path)}
                      style={{ paddingLeft: `${item.indent * 20}px` }}
                    >
                      <input
                        type="checkbox"
                        checked={mode !== 'none'}
                        ref={(el) => { if (el) el.indeterminate = mode === 'partial' }}
                        onChange={() => toggleFile(f.path)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span className="file-status" style={{ color: statusColor(label) }}>{label}</span>
                      <span className="file-name" title={f.path}>{item.display}</span>
                      {mode === 'partial' && <span className="partial-badge">partial</span>}
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="sidebar-footer">
              <button className="refresh-btn" onClick={() => repoPath && refresh(repoPath)} disabled={loading}>
                ↺ Refresh
              </button>
            </div>
          </aside>

          {/* Center: diff viewer */}
          <main className="diff-area">
            {activeFile && activeDiff ? (
              <DiffViewer
                filePath={activeFile}
                diff={activeDiff}
                fileMode={fileModes.get(activeFile) ?? 'none'}
                selectedHunkIds={new Set([...selectedHunks.keys()].filter((id) => id.startsWith(`${activeFile}::`)))}
                onToggleFile={() => toggleFileFromDiff(activeFile)}
                onToggleHunk={(id) => toggleHunk(activeFile, id)}
              />
            ) : (
              <div className="diff-empty"><span>Select a file to view diff</span></div>
            )}
          </main>

          {/* Right: commit / history */}
          <aside className="right-panel">
            <div className="tab-bar">
              <button className={`tab-btn${rightTab === 'commit' ? ' active' : ''}`} onClick={() => setRightTab('commit')}>Commit</button>
              <button className={`tab-btn${rightTab === 'history' ? ' active' : ''}`} onClick={() => setRightTab('history')}>History</button>
            </div>
            {rightTab === 'commit' ? (
              <CommitPanel
                repoPath={repoPath}
                wholeFiles={wholeFiles}
                hunkPatches={hunkPatches}
                totalCount={totalCount}
                onCommitted={() => refresh(repoPath)}
              />
            ) : (
              <HistoryPanel
                repoPath={repoPath}
                log={log}
                logError={logError}
                onReset={() => refresh(repoPath)}
              />
            )}
          </aside>
        </div>
      )}
      <footer className="footer">
        <span>Version {version}</span>
        <a href="https://mujdecisy.github.io" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>author ♥</a>
      </footer>
    </div>
  )
}
