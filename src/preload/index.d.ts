export interface FileStatus {
  path: string
  index: string
  working_dir: string
}

export interface StatusResult {
  files: FileStatus[]
  branch: string | null
  error?: string
}

export interface CommitEntry {
  hash: string
  hashShort: string
  message: string
  date: string
  author: string
}

export interface GitAPI {
  openProject(): Promise<string | null>
  getStatus(path: string): Promise<StatusResult>
  getDiff(path: string, file: string): Promise<string>
  getLog(path: string): Promise<CommitEntry[]>
  resetToCommit(path: string, hash: string, mode: string): Promise<void>
  createCommit(
    path: string,
    opts: { message: string; date: string; files: string[] }
  ): Promise<void>
}

declare global {
  interface Window {
    git: GitAPI
  }
}
