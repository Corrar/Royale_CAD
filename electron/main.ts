import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, type KeyboardInputEvent, type MouseInputEvent, type MouseWheelInputEvent } from 'electron'

const smoke = app.commandLine.hasSwitch('smoke')
const shot = app.commandLine.getSwitchValue('shot')
const loseContext = app.commandLine.hasSwitch('lose-context')
const play = app.commandLine.getSwitchValue('play')
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

const MOUSE_TYPES = ['mouseDown', 'mouseUp', 'mouseMove', 'mouseWheel']
const KEY_TYPES = ['keyDown', 'keyUp', 'char']
const MOUSE_NUMBERS = ['x', 'y', 'clickCount', 'deltaX', 'deltaY']

// Returns a wait in ms or an event for sendInputEvent; copies only known fields.
function parseStep(item: unknown, i: number): number | MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent {
  const bad = (why: string): never => {
    throw new Error(`--play step ${i}: ${why}`)
  }
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return bad('not an object')
  const o = item as Record<string, unknown>
  if ('wait' in o) {
    const ms = o.wait
    if (typeof ms !== 'number' || !(ms >= 0 && ms <= 5000)) return bad('wait must be a number in 0..5000')
    return ms
  }
  const type = o.type
  if (typeof type !== 'string') return bad('missing type')
  if (KEY_TYPES.includes(type)) {
    if (typeof o.keyCode !== 'string') return bad('keyCode must be a string')
    return { type, keyCode: o.keyCode } as KeyboardInputEvent
  }
  if (!MOUSE_TYPES.includes(type)) return bad(`unknown type ${type}`)
  const ev: Record<string, unknown> = { type }
  for (const key of MOUSE_NUMBERS) {
    if (!(key in o)) continue
    if (typeof o[key] !== 'number' || !Number.isFinite(o[key])) return bad(`${key} must be a finite number`)
    ev[key] = o[key]
  }
  if (typeof ev.x !== 'number' || typeof ev.y !== 'number') return bad('x and y are required')
  if ('button' in o) {
    if (o.button !== 'left' && o.button !== 'middle' && o.button !== 'right') return bad('invalid button')
    ev.button = o.button
  }
  return ev as unknown as MouseInputEvent
}

function parsePlay(text: string): ReturnType<typeof parseStep>[] {
  const data: unknown = JSON.parse(text)
  if (!Array.isArray(data)) throw new Error('--play file must be a JSON array')
  return data.map(parseStep)
}

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
        // Loading is done; the load watchdog yields to a deadline sized by the requested work.
        clearTimeout(smokeTimer)
        const steps = play ? parsePlay(await readFile(play, 'utf8')) : []
        const budget = 30_000 + steps.reduce<number>((sum, step) => sum + (typeof step === 'number' ? step : 0), 0)
        let stage = 'window show'
        smokeTimer = setTimeout(() => fail(`timeout: stage "${stage}" not finished ${budget} ms after page load`), budget)
        // The window must be shown and painted, or capturePage returns blank pixels.
        if (!win.isVisible()) await new Promise<void>((resolve) => win.once('show', () => resolve()))
        stage = 'first frames'
        await wc.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
        stage = 'fonts'
        const families: string[] = await wc.executeJavaScript(
          'Promise.all([...document.fonts].map(f => f.load().then(() => f.family)))',
        )
        if (families.length === 0) throw new Error('no @font-face registered')
        console.log(`fonts loaded: ${[...new Set(families)].join(', ')}`)
        if (loseContext) {
          stage = 'lose-context'
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
        if (play) {
          stage = 'play'
          for (const step of steps) {
            if (typeof step === 'number') await new Promise((r) => setTimeout(r, step))
            else wc.sendInputEvent(step)
          }
          await wc.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
        }
        stage = 'capture'
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
