import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import simpleGit from 'simple-git'

const HASH_SHORT_LEN = 7

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

// ── IPC Handlers ────────────────────────────────────────────────────────────

ipcMain.handle('git:openProject', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('git:getStatus', async (_, repoPath: string) => {
  try {
    const git = simpleGit(repoPath)
    const status = await git.status()
    return { files: status.files, branch: status.current }
  } catch (e) {
    return { files: [], branch: null, error: String(e) }
  }
})

ipcMain.handle('git:getDiff', async (_, repoPath: string, filePath: string) => {
  try {
    const git = simpleGit(repoPath)
    const status = await git.status()
    const file = status.files.find((f) => f.path === filePath)

    if (!file) {
      return ''
    }

    // Untracked file — show full content as additions
    if (file.index === '?' && file.working_dir === '?') {
      const content = readFileSync(join(repoPath, filePath), 'utf-8')
      const lines = content.split('\n')
      const body = lines.map((l) => `+${l}`).join('\n')
      return `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${body}`
    }

    // Try HEAD diff (staged + unstaged vs last commit)
    try {
      const headDiff = await git.diff(['HEAD', '--', filePath])
      if (headDiff.trim()) {
        return headDiff
      }
    } catch {
      // new repo with no commits — fall through
    }

    // Fallback: unstaged only
    const unstagedDiff = await git.diff(['--', filePath])
    if (unstagedDiff.trim()) {
      return unstagedDiff
    }

    // Staged only (new file added but not committed)
    return await git.diff(['--cached', '--', filePath])
  } catch (e) {
    return `Error getting diff: ${e}`
  }
})

ipcMain.handle('git:getLog', async (_, repoPath: string) => {
  try {
    const git = simpleGit(repoPath)
    const log = await git.log({ maxCount: 100 })
    return log.all.map((entry) => ({
      hash: entry.hash,
      hashShort: entry.hash.slice(0, HASH_SHORT_LEN),
      message: entry.message,
      date: entry.date.slice(0, 16).replace('T', ' '),
      author: entry.author_name
    }))
  } catch {
    return []
  }
})

ipcMain.handle('git:resetToCommit', async (_, repoPath: string, hash: string, mode: string) => {
  const git = simpleGit(repoPath)
  await git.reset([`--${mode}`, hash])
})

ipcMain.handle('git:getUpstreamInfo', async (_, repoPath: string) => {
  try {
    const git = simpleGit(repoPath)
    const branch = (await git.status()).current
    if (!branch) {
      return { upstream: null, behind: 0, error: 'Not on a branch' }
    }
    // get upstream tracking ref
    let upstream: string | null = null
    try {
      upstream = (await git.raw(['rev-parse', '--abbrev-ref', `${branch}@{u}`])).trim()
    } catch {
      return { upstream: null, behind: 0, error: 'No upstream configured' }
    }
    // count commits behind
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
  const git = simpleGit(repoPath)
  const branch = (await git.status()).current
  if (!branch) {
    throw new Error('Not on a branch')
  }
  const upstream = (await git.raw(['rev-parse', '--abbrev-ref', `${branch}@{u}`])).trim()
  await git.fetch()
  await git.reset([`--${mode}`, upstream])
})

ipcMain.handle(
  'git:createCommit',
  async (
    _,
    repoPath: string,
    opts: { message: string; date: string; files: string[]; patches: string[] }
  ) => {
    const git = simpleGit(repoPath)

    // Stage whole files
    if (opts.files.length > 0) {
      await git.add(opts.files)
    }

    // Apply patch strings for partial hunk selection
    for (const patch of opts.patches) {
      const tmp = join(tmpdir(), `commit-org-${Date.now()}.patch`)
      writeFileSync(tmp, patch, 'utf-8')
      try {
        await git.raw(['apply', '--cached', '--whitespace=nowarn', tmp])
      } finally {
        try {
          unlinkSync(tmp)
        } catch { /* ignore */ }
      }
    }

    await git
      .env({ GIT_AUTHOR_DATE: opts.date, GIT_COMMITTER_DATE: opts.date })
      .commit(opts.message)
  }
)

// ── App lifecycle ────────────────────────────────────────────────────────────

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
