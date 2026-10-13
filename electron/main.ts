import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, Menu } from 'electron'

const smoke = app.commandLine.hasSwitch('smoke')
const shot = app.commandLine.getSwitchValue('shot')
const loseContext = app.commandLine.hasSwitch('lose-context')
// BG, SYMBOL and BAR_H mirror --bg, --text and --titlebar-h in src/ui/tokens.css.
const BG = '#1B1D20'
const SYMBOL = '#E6E8EA'
const BAR_H = 32
const dev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL

let smokeTimer: NodeJS.Timeout | undefined
let exiting = false
// The first call wins, so a later exit(0) cannot overwrite an earlier failure.
function finish(code: number, reason?: string): void {
  if (exiting) return
  exiting = true
  clearTimeout(smokeTimer)
  if (reason) console.error(`smoke failed: ${reason}`)
  app.exit(code)
}
const fail = (reason: string): void => finish(1, reason)

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Royale CAD',
    backgroundColor: BG,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BG, symbolColor: SYMBOL, height: BAR_H },
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
  // Dev only: Vite's full reload (location.reload) navigates to the current URL.
  wc.on('will-navigate', (event) => {
    if (!(dev && event.url === wc.getURL())) event.preventDefault()
  })

  if (smoke) {
    smokeTimer = setTimeout(() => fail('timeout: page not loaded in 15 s'), 15_000)
    wc.on('did-fail-load', (_e, code, desc) => fail(`did-fail-load ${code} ${desc}`))
    wc.on('preload-error', (_e, path, error) => fail(`preload-error ${path}: ${error.message}`))
    wc.on('render-process-gone', (_e, details) => fail(`render-process-gone: ${details.reason}`))
    wc.on('console-message', (event) => {
      if (event.level === 'error') fail(`renderer console error: ${event.message}`)
    })
    wc.on('did-finish-load', () => {
      void (async () => {
        // The window must be shown and painted, or capturePage returns blank pixels.
        if (!win.isVisible()) await new Promise<void>((resolve) => win.once('show', () => resolve()))
        await wc.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
        const families: string[] = await wc.executeJavaScript(
          'Promise.all([...document.fonts].map(f => f.load().then(() => f.family)))',
        )
        if (families.length === 0) throw new Error('no @font-face registered')
        console.log(`fonts loaded: ${[...new Set(families)].join(', ')}`)
        if (loseContext) {
          await wc.executeJavaScript(`(async () => {
            const canvas = document.getElementById('viewport')
            const ext = canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')
            if (!ext) throw new Error('WEBGL_lose_context unavailable')
            const once = (name) => new Promise((resolve, reject) => {
              canvas.addEventListener(name, resolve, { once: true })
              setTimeout(() => reject(new Error('timeout waiting for ' + name)), 5000)
            })
            const lost = once('webglcontextlost')
            ext.loseContext()
            await lost
            // restoreContext() called right inside the lost event task is ignored by Chromium.
            await new Promise((r) => setTimeout(r, 100))
            const restored = once('webglcontextrestored')
            ext.restoreContext()
            await restored
            for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r))
          })()`)
          console.log('context lost and restored')
        }
        if (shot) await writeFile(shot, (await wc.capturePage()).toPNG())
        finish(0)
      })().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
    })
  }

  if (dev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

// Default menu shortcuts (Ctrl+R reload, Ctrl+W close) would discard an unsaved drawing.
if (!dev) Menu.setApplicationMenu(null)

void app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
