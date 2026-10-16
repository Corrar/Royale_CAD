import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The parts of electron the handlers use: the dialogs answer what the test sets, and record what they were asked.
const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  saveAnswer: { canceled: false, filePath: '' } as { canceled: boolean; filePath?: string },
  saveOptions: [] as { properties?: string[] }[],
  asked: [] as string[],
  answer: 0,
  dir: '',
}))
vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  dialog: {
    showSaveDialog: async (_win: unknown, options: { properties?: string[] }) => {
      h.saveOptions.push(options)
      return h.saveAnswer
    },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async (_win: unknown, options: { message: string }) => {
      h.asked.push(options.message)
      return { response: h.answer, checkboxChecked: false }
    },
    showMessageBoxSync: () => 2,
  },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => h.handlers.set(ch, fn),
    on: () => {},
  },
}))

const { registerFiles } = await import('./files')

/** A window whose top frame sends the messages; save-as answers as the handler does. */
function window() {
  const mainFrame = {}
  const wc = { mainFrame, send: () => {} }
  registerFiles({ webContents: wc, on: () => {}, close: () => {} } as never, null)
  const ev = { sender: wc, senderFrame: mainFrame }
  return { saveAs: (text: string) => h.handlers.get('file:save-as')!(ev, new TextEncoder().encode(text), 'Drawing1.dxf') }
}

beforeEach(async () => {
  h.dir = await mkdtemp(join(tmpdir(), 'royale-files-'))
  h.saveOptions.length = 0
  h.asked.length = 0
})
afterEach(async () => {
  await rm(h.dir, { recursive: true, force: true })
})

describe('SAVEAS', () => {
  it('asks the dialog to confirm a name that exists (Linux does not by default)', async () => {
    h.saveAnswer = { canceled: false, filePath: join(h.dir, 'Plant.dxf') }
    expect(await window().saveAs('NEW')).toEqual({ name: 'Plant.dxf' })
    expect(h.saveOptions[0]!.properties).toContain('showOverwriteConfirmation')
  })

  it('a name without .dxf (as a GTK dialog returns it) does not replace an existing Plant.dxf without asking', async () => {
    await writeFile(join(h.dir, 'Plant.dxf'), 'PRECIOUS')
    h.saveAnswer = { canceled: false, filePath: join(h.dir, 'Plant') }
    h.answer = 1 // Cancel
    expect(await window().saveAs('NEW')).toBeNull()
    expect(h.asked).toEqual(['Plant.dxf already exists. Do you want to replace it?'])
    expect(await readFile(join(h.dir, 'Plant.dxf'), 'utf8')).toBe('PRECIOUS')
    h.answer = 0 // Replace
    expect(await window().saveAs('NEW')).toEqual({ name: 'Plant.dxf' })
    expect(await readFile(join(h.dir, 'Plant.dxf'), 'utf8')).toBe('NEW')
  })

  it('no question when Plant.dxf does not exist yet, or when the dialog gave the name with .dxf', async () => {
    h.saveAnswer = { canceled: false, filePath: join(h.dir, 'Plant') }
    expect(await window().saveAs('A')).toEqual({ name: 'Plant.dxf' })
    h.saveAnswer = { canceled: false, filePath: join(h.dir, 'Plant.dxf') }
    expect(await window().saveAs('B')).toEqual({ name: 'Plant.dxf' })
    expect(h.asked).toEqual([])
    expect(await readdir(h.dir)).toEqual(['Plant.dxf'])
  })
})
