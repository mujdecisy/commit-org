import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import simpleGit, { type SimpleGit } from 'simple-git'

const execFileAsync = promisify(execFile)

// On Windows, GUI apps don't inherit the shell PATH, so git may not be found.
if (process.platform === 'win32') {
  const gitPaths = [
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\Git\\bin',
    'C:\\Program Files (x86)\\Git\\cmd',
  ]
  process.env['PATH'] = [...gitPaths, process.env['PATH'] ?? ''].join(';')
}

const HASH_SHORT_LEN = 7

// ── WSL path helpers ──────────────────────────────────────────────────────────

interface WslInfo { distro: string; linuxPath: string }

function parseWslPath(repoPath: string): WslInfo | null {
  // Matches \\wsl$\Ubuntu\... or \\wsl.localhost\Ubuntu\...
  const m = repoPath.replace(/\\/g, '/').match(/^\/\/(wsl\$|wsl\.localhost)\/([^/]+)(\/.*)?$/)
  if (!m) return null
  return { distro: m[2], linuxPath: m[3] ?? '/' }
}

/** Convert a Windows absolute path to the equivalent /mnt/x/... path inside WSL */
function winTmpToWslPath(winPath: string): string {
  return winPath
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`)
}

// ── Git adapter interface ─────────────────────────────────────────────────────

interface StatusFile { path: string; index: string; working_dir: string }
interface StatusResult { files: StatusFile[]; current: string | null }
interface LogEntry { hash: string; message: string; date: string; author_name: string }
interface LogResult { all: LogEntry[] }

interface GitAdapter {
  status(): Promise<StatusResult>
  diff(args: string[]): Promise<string>
  log(opts: { maxCount: number }): Promise<LogResult>
  reset(args: string[]): Promise<void>
  add(files: string[]): Promise<void>
  applyPatchCached(patchContent: string): Promise<void>
  commit(message: string, env?: Record<string, string>): Promise<void>
  raw(args: string[]): Promise<string>
  fetch(): Promise<void>
}

// ── SimpleGit adapter ─────────────────────────────────────────────────────────

class SimpleGitAdapter implements GitAdapter {
  private git: SimpleGit

  constructor(repoPath: string) {
    this.git = simpleGit(repoPath)
  }

  async status(): Promise<StatusResult> {
    const s = await this.git.status()
    return { files: s.files, current: s.current }
  }

  async diff(args: string[]): Promise<string> {
    return this.git.diff(args)
  }

  async log(opts: { maxCount: number }): Promise<LogResult> {
    const l = await this.git.log({ maxCount: opts.maxCount })
    return {
      all: l.all.map((e) => ({
        hash: e.hash,
        message: e.message,
        date: e.date,
        author_name: e.author_name
      }))
    }
  }

  async reset(args: string[]): Promise<void> {
    await this.git.reset(args as Parameters<SimpleGit['reset']>[0])
  }

  async add(files: string[]): Promise<void> {
    await this.git.add(files)
  }

  async applyPatchCached(patchContent: string): Promise<void> {
    const tmp = join(tmpdir(), `commit-org-${Date.now()}.patch`)
    writeFileSync(tmp, patchContent, 'utf-8')
    try {
      await this.git.raw(['apply', '--cached', '--whitespace=nowarn', tmp])
    } finally {
      try { unlinkSync(tmp) } catch { /* ignore */ }
    }
  }

  async commit(message: string, env?: Record<string, string>): Promise<void> {
    const g = env ? this.git.env(env) : this.git
    await g.commit(message)
  }

  async raw(args: string[]): Promise<string> {
    return this.git.raw(args)
  }

  async fetch(): Promise<void> {
    await this.git.fetch()
  }
}

// ── WSL git adapter ───────────────────────────────────────────────────────────

class WslGitAdapter implements GitAdapter {
  private distro: string
  private linuxPath: string

  constructor(distro: string, linuxPath: string) {
    this.distro = distro
    this.linuxPath = linuxPath
  }

  private bashEscape(s: string): string {
    // Single-quote escape: safe for any string value in bash
    return `'${s.replaceAll("'", "'\\''")}'`
  }

  private async run(args: string[], env?: Record<string, string>): Promise<string> {
    // Run bash via -e (no WSL shell wrapper) and pass all git args as positional
    // parameters through "$@". This prevents WSL from mis-parsing args that start
    // with "--" (like --soft, --hard) as its own option flags.
    // Env vars are injected into the bash script string with single-quote escaping.
    const envStr = env
      ? Object.entries(env).map(([k, v]) => `${k}=${this.bashEscape(v)}`).join(' ') + ' '
      : ''
    const script = `${envStr}git "$@"`
    // '_' is $0 (script name placeholder); git args start at $1 via "$@"
    const wslArgs = ['-d', this.distro, '-e', 'bash', '-c', script, '_', '-C', this.linuxPath, ...args]
    const { stdout } = await execFileAsync('wsl', wslArgs)
    return stdout
  }

  async status(): Promise<StatusResult> {
    const [porcelain, branchOut] = await Promise.all([
      this.run(['status', '--porcelain=v1']),
      this.run(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')
    ])
    const current = branchOut.trim() || null
    const files: StatusFile[] = porcelain
      .split('\n')
      .filter((l) => l.length >= 4)
      .map((l) => ({
        index: l[0],
        working_dir: l[1],
        path: l.slice(3).trim()
      }))
    return { files, current }
  }

  async diff(args: string[]): Promise<string> {
    return this.run(['diff', ...args]).catch(() => '')
  }

  async log(opts: { maxCount: number }): Promise<LogResult> {
    // %x00 = null byte — safe field/record separator, never shell-interpreted
    const out = await this.run([
      'log',
      `--max-count=${opts.maxCount}`,
      '--format=%H%x00%s%x00%ai%x00%an%x00'
    ])
    const all: LogEntry[] = out
      .split('\0')
      .reduce<string[][]>((rows, token, i) => {
        const idx = Math.floor(i / 4)
        if (!rows[idx]) rows[idx] = []
        rows[idx].push(token)
        return rows
      }, [])
      .filter((row) => row[0]?.trim())
      .map(([hash, message, date, authorName]) => ({
        hash: hash ?? '',
        message: message ?? '',
        date: date ?? '',
        author_name: authorName ?? ''
      }))
    return { all }
  }

  async reset(args: string[]): Promise<void> {
    await this.run(['reset', ...args])
  }

  async add(files: string[]): Promise<void> {
    await this.run(['add', '--', ...files])
  }

  async applyPatchCached(patchContent: string): Promise<void> {
    // Write patch to Windows temp dir which WSL can access as /mnt/...
    const winTmp = join(tmpdir(), `commit-org-${Date.now()}.patch`)
    writeFileSync(winTmp, patchContent, 'utf-8')
    const wslTmp = winTmpToWslPath(winTmp)
    try {
      await this.run(['apply', '--cached', '--whitespace=nowarn', wslTmp])
    } finally {
      try { unlinkSync(winTmp) } catch { /* ignore */ }
    }
  }

  async commit(message: string, env?: Record<string, string>): Promise<void> {
    await this.run(['commit', '-m', message], env)
  }

  async raw(args: string[]): Promise<string> {
    return this.run(args)
  }

  async fetch(): Promise<void> {
    await this.run(['fetch'])
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

function createGit(repoPath: string): GitAdapter {
  if (process.platform === 'win32') {
    const wsl = parseWslPath(repoPath)
    if (wsl) {
      return new WslGitAdapter(wsl.distro, wsl.linuxPath)
    }
  }
  return new SimpleGitAdapter(repoPath)
}

/** Read a file — works for both normal paths and WSL UNC paths (\\wsl$\... is a network share) */
function readFile(repoPath: string, filePath: string): string {
  // For WSL paths the UNC share is readable by Windows directly
  return readFileSync(join(repoPath, filePath), 'utf-8')
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && rendererUrl) {
    win.loadURL(rendererUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('git:openProject', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('git:getStatus', async (_, repoPath: string) => {
  try {
    const git = createGit(repoPath)
    const s = await git.status()
    return { files: s.files, branch: s.current }
  } catch (e) {
    return { files: [], branch: null, error: String(e) }
  }
})

ipcMain.handle('git:getDiff', async (_, repoPath: string, filePath: string) => {
  try {
    const git = createGit(repoPath)
    const s = await git.status()
    const file = s.files.find((f) => f.path === filePath)

    if (!file) {
      return ''
    }

    // Untracked file — show full content as additions
    if (file.index === '?' && file.working_dir === '?') {
      const content = readFile(repoPath, filePath)
      const lines = content.split('\n')
      const body = lines.map((l) => `+${l}`).join('\n')
      return `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${body}`
    }

    // Try HEAD diff
    try {
      const headDiff = await git.diff(['HEAD', '--', filePath])
      if (headDiff.trim()) {
        return headDiff
      }
    } catch {
      // new repo with no commits — fall through
    }

    const unstagedDiff = await git.diff(['--', filePath])
    if (unstagedDiff.trim()) {
      return unstagedDiff
    }

    return await git.diff(['--cached', '--', filePath])
  } catch (e) {
    return `Error getting diff: ${e}`
  }
})

ipcMain.handle('git:getLog', async (_, repoPath: string) => {
  try {
    const git = createGit(repoPath)
    const log = await git.log({ maxCount: 100 })
    return log.all.map((entry) => ({
      hash: entry.hash,
      hashShort: entry.hash.slice(0, HASH_SHORT_LEN),
      message: entry.message,
      date: entry.date.slice(0, 16).replace('T', ' '),
      author: entry.author_name
    }))
  } catch (e) {
    return { error: String(e) }
  }
})

ipcMain.handle('git:resetToCommit', async (_, repoPath: string, hash: string, mode: string) => {
  const git = createGit(repoPath)
  const trimmedHash = hash.trim()
  const trimmedMode = mode.trim()
  try {
    await git.raw(['cat-file', '-e', trimmedHash])
  } catch {
    throw new Error(`Commit ${trimmedHash} not found in repository`)
  }
  await git.reset([`--${trimmedMode}`, trimmedHash])
})

ipcMain.handle('git:getUpstreamInfo', async (_, repoPath: string) => {
  try {
    const git = createGit(repoPath)
    const s = await git.status()
    const branch = s.current
    if (!branch) {
      return { upstream: null, behind: 0, error: 'Not on a branch' }
    }
    let upstream: string | null = null
    try {
      upstream = (await git.raw(['rev-parse', '--abbrev-ref', `${branch}@{u}`])).trim()
    } catch {
      return { upstream: null, behind: 0, error: 'No upstream configured' }
    }
    const behind = Number.parseInt(
      (await git.raw(['rev-list', '--count', `HEAD..${upstream}`])).trim(),
      10
    )
    return { upstream, behind, error: null }
  } catch (e) {
    return { upstream: null, behind: 0, error: String(e) }
  }
})

ipcMain.handle('git:resetToUpstream', async (_, repoPath: string, mode: string) => {
  const git = createGit(repoPath)
  const s = await git.status()
  const branch = s.current
  if (!branch) {
    throw new Error('Not on a branch')
  }
  const upstream = (await git.raw(['rev-parse', '--abbrev-ref', `${branch}@{u}`])).trim()
  await git.fetch()
  await git.reset([`--${mode.trim()}`, upstream])
})

ipcMain.handle(
  'git:createCommit',
  async (
    _,
    repoPath: string,
    opts: { message: string; date: string; files: string[]; patches: string[] }
  ) => {
    const git = createGit(repoPath)

    if (opts.files.length > 0) {
      await git.add(opts.files)
    }

    for (const patch of opts.patches) {
      await git.applyPatchCached(patch)
    }

    await git.commit(opts.message, {
      GIT_AUTHOR_DATE: opts.date,
      GIT_COMMITTER_DATE: opts.date
    })
  }
)

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
