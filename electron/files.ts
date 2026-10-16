import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { MAX_BYTES, atomicWrite, safeName, withDxf } from './atomic'


const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The file operations of one window, as IPC handlers. The renderer never sees a path: it gets names and bytes,
 * and the drawing's file is whatever it opened (and adopted) or saved to last. Every message is checked to come
 * from the window's own top frame.
 */
export function registerFiles(win: BrowserWindow, initialPath: string | null): void {
  const wc = win.webContents
  let current: string | null = null
  let dirty = false
  let closing = false
  let initial = initialPath
  let nextToken = 1
  const pending = new Map<number, string>()

  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => e.sender === wc && e.senderFrame === wc.mainFrame
  const bytesOf = (b: unknown): Uint8Array => {
    if (!(b instanceof Uint8Array)) throw new Error('expected bytes')
    return b
  }

  async function read(path: string): Promise<{ token: number; name: string; bytes: Uint8Array }> {
    const bytes = await readFile(path)
    if (bytes.length > MAX_BYTES) throw new Error(`${basename(path)} is larger than 1 GB`)
    const token = nextToken++
    pending.set(token, path)
    return { token, name: basename(path), bytes }
  }

  async function saveTo(path: string, bytes: Uint8Array): Promise<{ name: string } | { error: string }> {
    try {
      await atomicWrite(path, bytes)
      current = path
      return { name: basename(path) }
    } catch (error) {
      return { error: errorText(error) }
    }
  }

  async function saveAs(bytes: Uint8Array, suggested: string): Promise<{ name: string } | { error: string } | null> {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save Drawing As',
      defaultPath: join(current ? dirname(current) : app.getPath('documents'), safeName(suggested)),
      filters: [{ name: 'DXF', extensions: ['dxf'] }],
    })
    if (r.canceled || !r.filePath) return null
    return saveTo(withDxf(r.filePath), bytes)
  }

  const handle = (channel: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error(`${channel}: not from this window`)
      return fn(...args)
    })
  }
  const on = (channel: string, fn: (...args: unknown[]) => void): void => {
    ipcMain.on(channel, (e, ...args) => {
      if (trusted(e)) fn(...args)
    })
  }

  handle('file:initial', async () => {
    const path = initial
    initial = null
    return path ? read(path) : null
  })
  handle('file:open', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open Drawing',
      defaultPath: current ? dirname(current) : app.getPath('documents'),
      filters: [{ name: 'DXF', extensions: ['dxf'] }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile'],
    })
    return r.canceled || r.filePaths.length === 0 ? null : read(r.filePaths[0]!)
  })
  handle('file:adopt', async (token) => {
    const path = typeof token === 'number' ? pending.get(token) : undefined
    if (path === undefined) throw new Error('unknown file')
    current = path
    pending.clear()
  })
  handle('file:save', async (bytes, suggested) => (current ? saveTo(current, bytesOf(bytes)) : saveAs(bytesOf(bytes), safeName(suggested))))
  handle('file:save-as', async (bytes, suggested) => saveAs(bytesOf(bytes), safeName(suggested)))
  handle('file:forget', async () => {
    current = null
  })
  on('file:dirty', (d) => {
    dirty = d === true
  })
  on('file:close-now', () => {
    closing = true
    win.close()
  })

  // Closing with unsaved changes asks first; Save goes through the renderer, which owns the drawing.
  win.on('close', (e) => {
    if (!dirty || closing) return
    e.preventDefault()
    const name = current ? basename(current) : 'the drawing'
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `Save changes to ${name}?`,
      detail: 'Your changes will be lost if you do not save them.',
    })
    if (choice === 0) wc.send('file:save-and-close')
    else if (choice === 1) {
      closing = true
      win.close()
    }
  })
}
