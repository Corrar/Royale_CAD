import { contextBridge, ipcRenderer } from 'electron'

// window.royale: the file operations of src/app/files.ts (FileApi). Paths stay in the main process.
contextBridge.exposeInMainWorld('royale', {
  initial: () => ipcRenderer.invoke('file:initial'),
  open: () => ipcRenderer.invoke('file:open'),
  chunk: (token: number, offset: number, length: number) => ipcRenderer.invoke('file:chunk', token, offset, length),
  adopt: (token: number) => ipcRenderer.invoke('file:adopt', token),
  save: (bytes: Uint8Array, suggested: string) => ipcRenderer.invoke('file:save', bytes, suggested),
  saveAs: (bytes: Uint8Array, suggested: string) => ipcRenderer.invoke('file:save-as', bytes, suggested),
  forget: () => ipcRenderer.invoke('file:forget'),
  setDirty: (dirty: boolean) => ipcRenderer.send('file:dirty', dirty),
  onSaveAndClose: (fn: () => void) => {
    const listener = (): void => fn()
    ipcRenderer.on('file:save-and-close', listener)
    return () => void ipcRenderer.removeListener('file:save-and-close', listener)
  },
  closeNow: () => ipcRenderer.send('file:close-now'),
})
