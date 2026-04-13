import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

contextBridge.exposeInMainWorld('electron', electronAPI)

contextBridge.exposeInMainWorld('git', {
  openProject: () => ipcRenderer.invoke('git:openProject'),
  getStatus: (path: string) => ipcRenderer.invoke('git:getStatus', path),
  getDiff: (path: string, file: string) => ipcRenderer.invoke('git:getDiff', path, file),
  getLog: (path: string) => ipcRenderer.invoke('git:getLog', path),
  resetToCommit: (path: string, hash: string, mode: string) =>
    ipcRenderer.invoke('git:resetToCommit', path, hash, mode),
  getUpstreamInfo: (path: string) => ipcRenderer.invoke('git:getUpstreamInfo', path),
  resetToUpstream: (path: string, mode: string) =>
    ipcRenderer.invoke('git:resetToUpstream', path, mode),
  createCommit: (
    path: string,
    opts: { message: string; date: string; files: string[]; patches: string[] }
  ) => ipcRenderer.invoke('git:createCommit', path, opts)
})
