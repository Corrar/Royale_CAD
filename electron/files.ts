import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { MAX_BYTES, atomicWrite, safeName, withDxf } from './atomic'


const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The file operations of one window, as IPC handlers. The renderer never sees a path: it gets names and bytes,
 * and the drawing's file is whatever it opened (and adopted) or saved to last. Every message is checked to come
 * from the window's own top frame. The file given at start goes out once initialReady settles (the G3 gate holds
 * it until the app has started).
 */
export function registerFiles(win: BrowserWindow, initialPath: string | null, initialReady: Promise<void> = Promise.resolve()): void {
  const wc = win.webContents
  let current: string | null = null
  let dirty = false
  let closing = false
  let initial = initialPath
  let nextToken = 1
  // Files read and not yet adopted: their path, and their bytes until the renderer has taken them all.
  const pending = new Map<number, { path: string; bytes: Uint8Array | null }>()

  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => e.sender === wc && e.senderFrame === wc.mainFrame
  const bytesOf = (b: unknown): Uint8Array => {
    if (!(b instanceof Uint8Array)) throw new Error('expected bytes')
    return b
  }

  /** Reads a file whole; the renderer takes its bytes in chunks (file:chunk), so no single message is big. */
  async function read(path: string): Promise<{ token: number; name: string; size: number }> {
    const bytes = await readFile(path)
    if (bytes.length > MAX_BYTES) throw new Error(`${basename(path)} is larger than 1 GB`)
    // One file at a time: an earlier read never adopted is dropped.
    pending.clear()
    const token = nextToken++
    pending.set(token, { path, bytes })
    return { token, name: basename(path), size: bytes.length }
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
      // Windows and macOS ask before a name that exists; GTK only when told to.
      properties: ['showOverwriteConfirmation'],
    })
    if (r.canceled || !r.filePath) return null
    const path = withDxf(r.filePath)
    // The dialog asked about the name as typed (GTK returns it without the extension): with .dxf added it may name
    // another file, which nobody was asked about.
    if (path !== r.filePath && (await stat(path).then(() => true, () => false))) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Replace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `${basename(path)} already exists. Do you want to replace it?`,
      })
      if (response !== 0) return null
    }
    return saveTo(path, bytes)
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
    await initialReady
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
  handle('file:chunk', async (token, offset, length) => {
    const p = typeof token === 'number' ? pending.get(token) : undefined
    if (!p?.bytes) throw new Error('unknown file')
    if (!Number.isInteger(offset) || !Number.isInteger(length) || (offset as number) < 0 || (length as number) <= 0) throw new Error('bad range')
    const end = Math.min(p.bytes.length, (offset as number) + (length as number))
    // A copy: a view would carry the whole file's buffer through the IPC.
    const chunk = new Uint8Array(p.bytes.subarray(offset as number, end))
    if (end === p.bytes.length) p.bytes = null // all taken
    return chunk
  })
  handle('file:adopt', async (token) => {
    const p = typeof token === 'number' ? pending.get(token) : undefined
    if (p === undefined) throw new Error('unknown file')
    current = p.path
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
