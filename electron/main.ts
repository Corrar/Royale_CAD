import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, Menu, session, type KeyboardInputEvent, type MouseInputEvent, type MouseWheelInputEvent } from 'electron'
import { registerFiles } from './files'

const smoke = app.commandLine.hasSwitch('smoke')
const shot = app.commandLine.getSwitchValue('shot')
const loseContext = app.commandLine.hasSwitch('lose-context')
const play = app.commandLine.getSwitchValue('play')
// A DXF to open at start: for smoke runs now, for file associations later.
const openPath = app.commandLine.getSwitchValue('open') || null
// BG, SYMBOL and BAR_H mirror --bg, --text and --titlebar-h in src/ui/tokens.css.
const BG = '#1B1D20'
const SYMBOL = '#E6E8EA'
const BAR_H = 32
const dev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
const bench = app.commandLine.hasSwitch('bench')
const hasGate = app.commandLine.hasSwitch('gate')
const gate = hasGate ? app.commandLine.getSwitchValue('gate') : 'g1'
const G1_LIMIT_MS = 16.7
// G2 (src/app/bench.ts): memory after a full GC (JS heap plus ArrayBuffers), index rebuild after edits, pick p95.
const G2_LIMITS = { memoryMB: 400, rebuildMs: 200, pickMs: 1 }
// What the G2 run must have done for its numbers to mean anything: picks that hit, one cold build, then a
// rebuild after each of the 6 edit rounds (1 warm-up + 5 measured).
const G2_WORK = { minPickHits: 900, coldBuilds: 1, indexRebuilds: 7 }
const BENCH_TIMEOUT_MS = 120_000
// G3: a big DXF opens in the real app while it keeps drawing frames, from the open until the scene and the spatial
// index are built, and half a second more. The UI counts as frozen when a frame waits longer than this.
const G3_MAX_FRAME_GAP_MS = 200
/** The app counts as started when no frame gap or task has passed 50 ms for this long. */
const G3_SETTLED_MS = 500
/**
 * Watches the renderer: the longest frame gap and main-thread task, and every one over 100 ms. slow is when the
 * last gap or task over 50 ms ended; __resetFrames() starts the count again.
 */
const FRAME_MONITOR = `(() => {
  const f = (window.__frames = { max: 0, gaps: [], last: performance.now(), start: 0, longest: 0, tasks: [], slow: performance.now() })
  const reset = (window.__resetFrames = () => void Object.assign(f, { max: 0, gaps: [], start: performance.now(), longest: 0, tasks: [] }))
  reset()
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration > f.longest) f.longest = e.duration
      if (e.duration > 100) f.tasks.push(Math.round(e.duration) + '@' + Math.round(e.startTime - f.start))
      if (e.duration > 50) f.slow = Math.max(f.slow, e.startTime + e.duration)
    }
  }).observe({ type: 'longtask' })
  const tick = (t) => {
    const gap = t - f.last
    if (gap > f.max) f.max = gap
    if (gap > 100) f.gaps.push(Math.round(gap) + '@' + Math.round(f.last - f.start))
    if (gap > 50) f.slow = t
    f.last = t
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

/**
 * Renderer memory after a full collection, in MB, through the DevTools protocol. usedSize is the V8 heap alone;
 * the backing stores of ArrayBuffers (typed arrays, GPU-side copies) come in backingStorageSize.
 */
async function measureMemoryMB(wc: Electron.WebContents): Promise<{ heapMB: number; arrayBuffersMB: number }> {
  wc.debugger.attach('1.3')
  try {
    await wc.debugger.sendCommand('HeapProfiler.collectGarbage')
    const usage = (await wc.debugger.sendCommand('Runtime.getHeapUsage')) as { usedSize: number; backingStorageSize?: number }
    return { heapMB: Math.round(usage.usedSize / 1e6), arrayBuffersMB: Math.round((usage.backingStorageSize ?? NaN) / 1e6) }
  } finally {
    wc.debugger.detach()
  }
}

let smokeTimer: NodeJS.Timeout | undefined
let exiting = false
// The first call wins, so a later exit(0) cannot overwrite an earlier failure.
function finish(code: number, reason?: string): void {
  if (exiting) return
  exiting = true
  clearTimeout(smokeTimer)
  if (reason) console.error(`${bench ? 'bench' : 'smoke'} failed: ${reason}`)
  app.exit(code)
}
const fail = (reason: string): void => finish(1, reason)

let benchN = 1_000_000
const hasPlay = app.commandLine.hasSwitch('play')
const hasN = app.commandLine.hasSwitch('n')
const rawN = app.commandLine.getSwitchValue('n')
const conflict = bench && (smoke || hasPlay || loseContext)
  ? '--bench cannot be combined with --smoke, --play or --lose-context'
  : (hasPlay || loseContext) && !smoke
    ? '--play and --lose-context need --smoke'
    : (hasN || hasGate) && !bench
      ? '--n and --gate need --bench'
      : (hasPlay && play === '') || (hasN && rawN === '')
        ? '--play and --n need a value'
        : gate !== 'g1' && gate !== 'g2' && gate !== 'g3'
          ? `--gate must be g1, g2 or g3, got "${gate}"`
          : gate === 'g3' && !openPath
            ? '--gate=g3 needs --open=<a DXF file>'
            : undefined
if (conflict) finish(1, conflict)
else if (bench && rawN !== '') {
  benchN = /^\d+$/.test(rawN) ? Number(rawN) : NaN
  if (!(benchN >= 1 && benchN <= 5_000_000)) finish(1, `--n must be an integer in 1..5000000, got "${rawN}"`)
}

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
    fullscreen: bench, // the gate is defined at 1080p
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(import.meta.dirname, '../preload/preload.cjs'),
    },
  })
  const wc = win.webContents
  const g3 = bench && gate === 'g3'
  // G3 opens the file once the app has started, so its own start does not count as the file's.
  let started = (): void => {}
  if (!bench || g3) registerFiles(win, openPath, g3 ? new Promise<void>((r) => (started = r)) : undefined)

  win.once('ready-to-show', () => win.show())
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Dev only: Vite's full reload (location.reload) navigates to the current URL.
  wc.on('will-navigate', (event) => {
    if (!(dev && event.url === wc.getURL())) event.preventDefault()
  })

  if (smoke || bench) {
    smokeTimer = bench
      ? setTimeout(() => fail(`timeout: no result in ${BENCH_TIMEOUT_MS / 1000} s`), BENCH_TIMEOUT_MS)
      : setTimeout(() => fail('timeout: page not loaded in 15 s'), 15_000)
    wc.on('did-fail-load', (_e, code, desc) => fail(`did-fail-load ${code} ${desc}`))
    wc.on('preload-error', (_e, path, error) => fail(`preload-error ${path}: ${error.message}`))
    wc.on('render-process-gone', (_e, details) => fail(`render-process-gone: ${details.reason}`))
    wc.on('console-message', (event) => {
      if (event.level === 'error') fail(`renderer console error: ${event.message}`)
    })
  }

  if (g3) {
    wc.on('did-finish-load', () => {
      void (async () => {
        await wc.executeJavaScript(FRAME_MONITOR)
        // Started: frames have come smoothly for a while. Then the count begins and the file opens.
        for (;;) {
          await new Promise((r) => setTimeout(r, 100))
          if (await wc.executeJavaScript(`performance.now() - window.__frames.slow > ${G3_SETTLED_MS}`)) break
        }
        await wc.executeJavaScript('window.__resetFrames()')
        started()
        // Opened: the title names the file, nothing is under way any more, and the scene and the index have been
        // built since the file was read (a big drawing builds in tasks after the load).
        const name = basename(openPath!)
        for (;;) {
          await new Promise((r) => setTimeout(r, 100))
          const done: boolean = await wc.executeJavaScript(
            `document.title.startsWith(${JSON.stringify(name)}) && !document.querySelector('.titlebar-busy') && (performance.getEntriesByName('royale:built').at(-1)?.startTime ?? -1) >= (performance.getEntriesByName('royale:framed').at(-1)?.startTime ?? Infinity)`,
          )
          if (done) break
        }
        // A few more frames of the drawing on screen.
        await new Promise((r) => setTimeout(r, 500))
        const r = (await wc.executeJavaScript(
          `({ ...window.__frames, loadMs: Math.round(performance.now() - window.__frames.start - 500), last: document.querySelector('.cmdline-history li:last-child')?.textContent ?? null, objects: performance.getEntriesByName('royale:loaded').at(-1)?.detail?.objects ?? null, marks: performance.getEntriesByType('mark').filter((m) => m.name.startsWith('royale:')).map((m) => m.name.slice(7) + ' ' + Math.round(m.startTime - window.__frames.start)) })`,
        )) as { max: number; gaps: string[]; longest: number; tasks: string[]; loadMs: number; last: string | null; objects: number | null; marks: string[] }
        const opened = r.objects
        console.log(JSON.stringify({ gate: 'g3', file: name, opened, loadMs: r.loadMs, longestTaskMs: Math.round(r.longest), tasksOver100Ms: r.tasks, maxFrameGapMs: Math.round(r.max), gapsOver100Ms: r.gaps, marks: r.marks }))
        if (opened === null) return fail(`the file did not open: ${r.last ?? 'no message'}`)
        if (shot) await writeFile(shot, (await wc.capturePage()).toPNG())
        finish(r.max <= G3_MAX_FRAME_GAP_MS ? 0 : 2)
      })().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
    })
  }

  if (bench && !g3) {
    let received = false
    wc.on('console-message', (event) => {
      if (received || !event.message.startsWith('BENCH_RESULT ')) return
      received = true
      void (async () => {
        const r = JSON.parse(event.message.slice('BENCH_RESULT '.length)) as Record<string, unknown>
        if (gate === 'g2' && typeof r.error !== 'string') {
          Object.assign(r, await measureMemoryMB(wc))
          r.memoryMB = (r.heapMB as number) + (r.arrayBuffersMB as number)
        }
        console.log(JSON.stringify(r))
        const num = (k: string): number => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? r[k] : NaN)
        if (typeof r.error === 'string') return fail(r.error)
        if (r.gate !== gate) return fail(`result is for gate ${String(r.gate)}, not ${gate}`)
        if (r.n !== benchN) return fail(`result n ${String(r.n)} is not the requested ${benchN}`)
        let pass: boolean
        if (gate === 'g1') {
          if (Number.isNaN(num('p95')) || r.frames !== 300) return fail('invalid result')
          // G1 is defined for the requested scene at 1080p.
          if (r.width !== 1920 || r.height !== 1080) return fail(`drawing buffer ${String(r.width)}x${String(r.height)} is not 1920x1080`)
          pass = num('p95') <= G1_LIMIT_MS
        } else {
          const [memory, rebuild, pickMs] = [num('memoryMB'), num('rebuildMaxMs'), num('pickP95Ms')]
          if ([memory, rebuild, pickMs].some(Number.isNaN)) return fail('invalid result')
          if (!(num('pickHits') >= G2_WORK.minPickHits)) return fail(`only ${String(r.pickHits)} picks hit: the index is not answering`)
          if (r.coldBuilds !== G2_WORK.coldBuilds || r.indexRebuilds !== G2_WORK.indexRebuilds) {
            return fail(`expected ${G2_WORK.coldBuilds} cold build and ${G2_WORK.indexRebuilds} rebuilds, got ${String(r.coldBuilds)} and ${String(r.indexRebuilds)}`)
          }
          pass = memory <= G2_LIMITS.memoryMB && rebuild <= G2_LIMITS.rebuildMs && pickMs <= G2_LIMITS.pickMs
        }
        if (shot) await writeFile(shot, (await wc.capturePage()).toPNG())
        finish(pass ? 0 : 2)
      })().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
    })
  }

  if (smoke) {
    wc.on('did-finish-load', () => {
      void (async () => {
        // Loading is done; the load watchdog yields to a deadline sized by the requested work.
        let stage = 'reading --play file'
        clearTimeout(smokeTimer)
        // Armed before the read so it has a deadline; re-armed below once the script's waits are known.
        smokeTimer = setTimeout(() => fail(`timeout: stage "${stage}" not finished 30000 ms after page load`), 30_000)
        const steps = play ? parsePlay(await readFile(play, 'utf8')) : []
        const budget = 30_000 + steps.reduce<number>((sum, step) => sum + (typeof step === 'number' ? step : 0), 0)
        stage = 'window show'
        clearTimeout(smokeTimer)
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

  const query = bench && !g3 ? { bench: String(benchN), gate } : undefined
  if (dev) void win.loadURL(process.env.ELECTRON_RENDERER_URL! + (query ? `?${new URLSearchParams(query)}` : ''))
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { query })
}

// Default menu shortcuts (Ctrl+R reload, Ctrl+W close) would discard an unsaved drawing.
if (!dev) Menu.setApplicationMenu(null)

void app.whenReady().then(() => {
  // No camera, microphone, notifications, geolocation…: a CAD needs none of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  createWindow()
})
app.on('window-all-closed', () => app.quit())
