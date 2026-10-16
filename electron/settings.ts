import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import { atomicWrite } from './atomic'

/** settings.json holds a few hundred aliases at most: more is a mistake, not settings. */
export const MAX_SETTINGS_BYTES = 1 << 20

/** The text of the settings file at path; null when there is none (or no path: nothing to read). */
export async function readSettings(path: string | null): Promise<string | null> {
  if (path === null) return null
  try {
    const bytes = await readFile(path)
    if (bytes.length > MAX_SETTINGS_BYTES) throw new Error('settings.json is larger than 1 MB')
    return new TextDecoder().decode(bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Replaces the settings file at path whole (atomically), making its folder if need be; the error, if any. */
export async function writeSettings(path: string | null, text: unknown): Promise<{ error: string } | null> {
  if (typeof text !== 'string') return { error: 'settings must be text' }
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > MAX_SETTINGS_BYTES) return { error: 'settings.json would be larger than 1 MB' }
  if (path === null) return null
  try {
    await mkdir(dirname(path), { recursive: true })
    await atomicWrite(path, bytes)
    return null
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** settings:read and settings:write for one window, from its own top frame only. */
export function registerSettings(win: BrowserWindow, path: string | null): void {
  const wc = win.webContents
  ipcMain.handle('settings:read', (e) => {
    if (e.sender !== wc || e.senderFrame !== wc.mainFrame) throw new Error('settings:read: not from this window')
    return readSettings(path)
  })
  ipcMain.handle('settings:write', (e, text: unknown) => {
    if (e.sender !== wc || e.senderFrame !== wc.mainFrame) throw new Error('settings:write: not from this window')
    return writeSettings(path, text)
  })
}
