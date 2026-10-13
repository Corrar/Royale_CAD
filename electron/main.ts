import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, Menu } from 'electron'

const smoke = app.commandLine.hasSwitch('smoke')
const shot = app.commandLine.getSwitchValue('shot')
const dev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL

function fail(reason: string): void {
  console.error(`smoke failed: ${reason}`)
  app.exit(1)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Royale CAD',
    backgroundColor: '#1B1D20',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(import.meta.dirname, '../preload/preload.cjs'),
    },
  })
  const wc = win.webContents

  win.once('ready-to-show', () => win.show())
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (event) => event.preventDefault())

  if (smoke) {
    const timer = setTimeout(() => fail('timeout: page not loaded in 15 s'), 15_000)
    wc.on('did-fail-load', (_e, code, desc) => fail(`did-fail-load ${code} ${desc}`))
    wc.on('preload-error', (_e, path, error) => fail(`preload-error ${path}: ${error.message}`))
    wc.on('render-process-gone', (_e, details) => fail(`render-process-gone: ${details.reason}`))
    wc.on('console-message', (event) => {
      if (event.level === 'error') fail(`renderer console error: ${event.message}`)
    })
    wc.on('did-finish-load', async () => {
      // The window must be shown and painted, or capturePage returns blank pixels.
      if (!win.isVisible()) await new Promise<void>((resolve) => win.once('show', () => resolve()))
      await wc.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
      if (shot) await writeFile(shot, (await wc.capturePage()).toPNG())
      clearTimeout(timer)
      app.exit(0)
    })
  }

  if (dev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

// Default menu shortcuts (Ctrl+R reload, Ctrl+W close) would discard an unsaved drawing.
if (!dev) Menu.setApplicationMenu(null)

void app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
