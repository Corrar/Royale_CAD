import { BUILTIN_COMMANDS } from '../kernel/command/commands'
import { createInterpreter, type InterpreterHost } from '../kernel/command/runtime'
import { createDocument, docExtents, type Layer } from '../kernel/document'
import type { BBox, Vec2 } from '../kernel/geom/vec'
import { pick, pickBox } from '../kernel/pick'
import { createSelection } from '../kernel/selection'
import { APERTURE_PX, snap } from '../kernel/snap'
import { createSpatialIndex } from '../kernel/spatial'
import { FIT_MARGIN_PX, fit, screenToWorld, type ViewState } from '../kernel/view'
import { drawOverlay, type OverlayTheme } from '../render/overlay'
import { createGlyphAtlas } from '../render/glyphs'
import { createScene } from '../render/scene'
import { createWebGL2Backend } from '../render/webgl2/backend'
import { createFiles, type FileState } from './files'
import { canvasRaster, GLYPH_CAP_PX, GLYPH_SPREAD_PX, GLYPH_SUPERSAMPLE } from './glyph-raster'
import { attachInput, attachKeyboard } from './input'
import { parseInWorker } from './parse-worker'
import { DEFAULT_SETTINGS, parseSettings, settingsText, type Settings } from './settings'
import { createStore, derivedStore, type Store } from './stores'
import { packRgba, readBackendTheme, readCssColor } from './theme'

/** Half side of the pick box, CSS px. */
export const PICKBOX_PX = 5

/** What an empty drawing frames: an A3 sheet in millimetres, like AutoCAD's metric limits. */
const DEFAULT_EXTENTS = { minX: 0, minY: 0, maxX: 420, maxY: 297 }

/** Work on a big rebuild (scene or index) per task between frames, ms: input and frames get their turn in between. */
const BUILD_TASK_MS = 12
/** Lines of history the command line can show. */
const HISTORY_KEEP = 200

export interface CommandLineState {
  prompt: string
  /** Typed and not yet submitted. */
  buffer: string
  history: readonly string[]
  /** The number of history[0] among all lines said: a stable key for each line. */
  first: number
  expanded: boolean
}

export type Setting = 'grid' | 'ortho' | 'osnap'

export interface StatusState {
  /** Where a click would land, world; null without a cursor over the drawing. */
  x: number | null
  y: number | null
  grid: boolean
  ortho: boolean
  osnap: boolean
}

export interface LayersState {
  layers: readonly Layer[]
  /** The current layer, where new entities go. */
  current: number
  /** The list is showing. */
  open: boolean
}

/** What the layer panel can do. */
export interface LayerActions {
  setCurrent(index: number): void
  update(index: number, patch: Partial<Layer>): void
  /** A new layer, LayerN, made current. */
  add(): void
  toggle(): void
}

export type SettingsTab = 'osnap' | 'aliases'

export interface SettingsState {
  settings: Settings
  /** The settings panel shows, at this tab; null when closed. */
  open: SettingsTab | null
}

/** What the settings panel can do; every change is saved at once. */
export interface SettingsActions {
  show(tab: SettingsTab | null): void
  setOsnap(modes: number): void
  /** Adds or changes an alias; null removes it. */
  setAlias(alias: string, command: string | null): void
  resetAliases(): void
  /** The commands an alias can name. */
  commands: readonly string[]
}

export interface AppSession {
  commandLine: Store<CommandLineState>
  status: Store<StatusState>
  /** The drawing's file; null where there are no files (a plain browser). */
  file: Store<FileState> | null
  layers: Store<LayersState>
  layerActions: LayerActions
  /** The command under way, by name; null at the Command prompt. */
  active: Store<string | null>
  settings: Store<SettingsState>
  settingsActions: SettingsActions
  /** A toolbar button: ends the command under way, then types inputs (a command and its first answers). */
  runCommand(inputs: readonly string[]): void
  toggleHistory(): void
  toggle(setting: Setting): void
  dispose(): void
}


export function createFrameLoop(
  requestFrame: (cb: () => void) => void,
  draw: () => void,
): { invalidate(): void; flush(): void } {
  let dirty = false
  let scheduled = false
  const run = (): void => {
    scheduled = false
    flush()
  }
  const flush = (): void => {
    if (!dirty) return
    dirty = false
    draw()
  }
  return {
    invalidate() {
      dirty = true
      if (scheduled) return
      scheduled = true
      requestFrame(run)
    },
    flush,
  }
}

export function startApp(canvas: HTMLCanvasElement, overlay: HTMLCanvasElement): AppSession {
  const backend = createWebGL2Backend(canvas, readBackendTheme(canvas))
  const overlayCtx = overlay.getContext('2d')
  if (!overlayCtx) throw new Error('the overlay canvas has no 2D context')
  const token = (name: string): string => getComputedStyle(canvas).getPropertyValue(name).trim()
  const overlayTheme: OverlayTheme = {
    crosshair: token('--text'),
    preview: token('--accent'),
    window: token('--accent'),
    windowFill: token('--window-fill'),
    crossingFill: token('--crossing-fill'),
    snap: token('--snap'),
  }
  const doc = createDocument()
  // Glyphs are drawn between frames (glyphsBetweenFrames), in the text font: App waits for it to load. Printable ASCII
  // is drawn from the start, so most text shows at once.
  const raster = canvasRaster(GLYPH_CAP_PX * GLYPH_SUPERSAMPLE)
  const glyphs = createGlyphAtlas({ raster, capPx: GLYPH_CAP_PX, spread: GLYPH_SPREAD_PX, supersample: GLYPH_SUPERSAMPLE })
  for (let cp = 0x21; cp < 0x7f; cp++) glyphs.index(cp)
  const scene = createScene(doc, backend, {
    drawColor: packRgba(readCssColor(canvas, '--draw')),
    highlightColor: packRgba(readCssColor(canvas, '--accent')),
    glyphs,
  })
  const index = createSpatialIndex(doc)
  const selection = createSelection()

  let view: ViewState | null = null
  let cursor: Vec2 | null = null // CSS px over the viewport; kept when it leaves, for the rubber band
  let inside = false
  let sceneDirty = true
  /** Tasks are working on the scene's rebuild or the index's between frames (buildBetweenFrames). */
  let building = false
  /** Tasks are drawing glyphs into the atlas between frames (glyphsBetweenFrames). */
  let drawingGlyphs = false

  const host: InterpreterHost = {
    getView: () => view!,
    setView: (v) => setView(v),
    extents: () => docExtents(doc),
    pick: (p) => pick(doc, index, p, PICKBOX_PX / view!.scale),
    pickBox: (b, crossing) => pickBox(doc, index, b, crossing),
    snap: (p, base) => snap(doc, index, p, view!, settings.get().settings.osnap, APERTURE_PX, base),
    query: (b) => index.query(b),
  }
  const interp = createInterpreter(doc, selection, { commands: BUILTIN_COMMANDS, host })
  const frame = (extents?: BBox | null): void => {
    if (view) setView(fit(view, (extents === undefined ? docExtents(doc) : extents) ?? DEFAULT_EXTENTS, FIT_MARGIN_PX))
  }
  const files = window.royale
    ? createFiles({
        api: window.royale,
        doc,
        parse: parseInWorker,
        print: (line) => interp.print(line),
        replaced: (currentLayer, extents) => {
          selection.clear()
          const i = currentLayer === null ? -1 : doc.layers.indexOf(currentLayer)
          interp.layer = i >= 0 ? i : 0
          frame(extents)
          performance.mark('royale:framed')
          // A small drawing is whole already; a big one is when buildBetweenFrames ends.
          if (!scene.building && !index.building) performance.mark('royale:built')
        },
        currentLayer: () => doc.layers.get(interp.layer)!.name,
      })
    : null
  if (files) host.files = files
  const panelOpen = createStore(false)
  host.showLayers = () => panelOpen.set(true)

  // Settings: the defaults until settings.json is read; then what it says, its problems said in the command line.
  const settings = createStore<SettingsState>({ settings: DEFAULT_SETTINGS, open: null })
  const commandNames = Object.keys(BUILTIN_COMMANDS).sort()
  const applySettings = (next: Settings): void => {
    settings.set({ ...settings.get(), settings: next })
    interp.aliases = next.aliases
    loop.invalidate() // the snap marker may change with the modes
  }
  const saveSettings = (next: Settings): void => {
    applySettings(next)
    void window.royaleSettings?.write(settingsText(next)).then(
      (r) => r && interp.print(`Settings were not saved: ${r.error}`),
      (error: unknown) => interp.print(`Settings were not saved: ${error instanceof Error ? error.message : String(error)}`),
    )
  }
  window.royaleSettings?.read().then(
    (text) => {
      const { settings: read, warnings } = parseSettings(text, new Set(commandNames))
      applySettings(read)
      for (const w of warnings) interp.print(w)
    },
    (error: unknown) => interp.print(`Settings could not be read (${error instanceof Error ? error.message : String(error)}); the defaults are used.`),
  )
  host.showSettings = (tab) => settings.set({ ...settings.get(), open: tab })
  const settingsActions: SettingsActions = {
    show: (tab) => settings.set({ ...settings.get(), open: tab }),
    setOsnap: (modes) => saveSettings({ ...settings.get().settings, osnap: modes }),
    setAlias(alias, command) {
      const aliases = { ...settings.get().settings.aliases }
      if (command === null) delete aliases[alias]
      else aliases[alias] = command
      saveSettings({ ...settings.get().settings, aliases })
    },
    resetAliases: () => saveSettings({ ...settings.get().settings, aliases: DEFAULT_SETTINGS.aliases }),
    commands: commandNames,
  }

  const loop = createFrameLoop(
    (cb) => requestAnimationFrame(cb),
    () => {
      if (!view) return
      if (sceneDirty) {
        sceneDirty = false
        backend.frame(view, scene.draws(view))
        if (scene.building || index.building) buildBetweenFrames()
        if (glyphs.pending) glyphsBetweenFrames()
      }
      const r = interp.request
      const tracked = interp.tracked
      drawOverlay(
        overlayCtx,
        {
          view,
          cursor,
          crosshair: inside,
          pickbox: !r || r.kind === 'selection' || (r.kind === 'point' && r.pick === true),
          preview: r && (r.kind === 'point' || r.kind === 'number') ? (r.preview ?? null) : null,
          corner: interp.corner,
          snap: tracked?.snap ?? null,
          aim: tracked?.p ?? null,
        },
        overlayTheme,
        PICKBOX_PX,
      )
    },
  )
  const redrawScene = (): void => {
    sceneDirty = true
    loop.invalidate()
  }
  /**
   * Works on a big rebuild of the scene, then of the spatial index, in tasks until both end, then draws the result.
   * Tasks, not frames: the drawing on screen does not change meanwhile, and frames that wait on a slow GPU would
   * hold the rebuild back. Until the index is whole, picks and snaps scan every bbox.
   */
  function buildBetweenFrames(): void {
    if (building) return
    building = true
    const step = (): void => {
      if (view === null) return // disposed
      if (scene.building) scene.build(BUILD_TASK_MS)
      else {
        const end = performance.now() + BUILD_TASK_MS
        index.build(() => performance.now() < end)
      }
      if (scene.building || index.building) {
        setTimeout(step, 0)
        return
      }
      building = false
      performance.mark('royale:built')
      redrawScene()
    }
    setTimeout(step, 0)
  }
  /** Draws the glyphs text asked for, a task at a time; each task's glyphs show in the next frame. */
  function glyphsBetweenFrames(): void {
    if (drawingGlyphs) return
    drawingGlyphs = true
    const step = (): void => {
      if (view === null) return // disposed
      const end = performance.now() + BUILD_TASK_MS
      glyphs.work(() => performance.now() < end)
      redrawScene()
      if (glyphs.pending) setTimeout(step, 0)
      else drawingGlyphs = false
    }
    setTimeout(step, 0)
  }
  function setView(v: ViewState): void {
    view = v
    interp.cursor = cursor && screenToWorld(v, cursor.x, cursor.y)
    // The same screen point is somewhere else in the world now: the status must say where.
    tracking.set(tracking.get() + 1)
    redrawScene()
  }

  const offDoc = doc.onChange((c) => {
    if (c.removed.length > 0) selection.remove(c.removed.map((e) => e.id))
    // The slices of a file being read: the scene shows them when the reading ends and replaced() frames them.
    if (!c.bulk) redrawScene()
  })
  const offLayers = doc.layers.onChange(redrawScene)
  const offRestore = backend.onRestore(redrawScene)
  const offSelection = selection.onChange(() => {
    scene.setHighlight(selection.ids)
    redrawScene()
  })
  const offInterp = interp.onChange(() => loop.invalidate())

  const buffer = createStore('')
  const expanded = createStore(false)
  const grid = createStore(true)
  const tracking = createStore(0) // ticks when the cursor or the view moves: the status shows where a click lands
  const offGrid = grid.subscribe(() => {
    backend.setGrid(grid.get())
    redrawScene()
  })
  const toggle = (setting: Setting): void => {
    if (setting === 'grid') grid.set(!grid.get())
    else if (setting === 'ortho') interp.ortho = !interp.ortho
    else interp.osnap = !interp.osnap
  }
  const status = derivedStore(
    () => {
      const at = interp.tracked?.p ?? null
      return { x: at?.x ?? null, y: at?.y ?? null, grid: grid.get(), ortho: interp.ortho, osnap: interp.osnap }
    },
    { subscribe: (fn) => interp.onChange(fn) },
    grid,
    tracking,
  )
  const active = derivedStore(() => interp.command, { subscribe: (fn) => interp.onChange(fn) })
  const commandLine = derivedStore(
    () => {
      const history = interp.history.slice(-HISTORY_KEEP)
      return { prompt: interp.prompt, buffer: buffer.get(), history, first: interp.said - history.length, expanded: expanded.get() }
    },
    { subscribe: (fn) => interp.onChange(fn) },
    buffer,
    expanded,
  )
  const toggleHistory = (): void => expanded.set(!expanded.get())
  // The interpreter notifies on every key: the same state comes back unless a layer, the current one or the panel
  // changed, so the panel does not render for nothing.
  let lastLayers: LayersState = { layers: [], current: -1, open: false }
  const layersNow = (): LayersState => {
    const list = Array.from({ length: doc.layers.size }, (_, i) => doc.layers.get(i)!)
    const same = list.length === lastLayers.layers.length && list.every((l, i) => l === lastLayers.layers[i])
    if (same && interp.layer === lastLayers.current && panelOpen.get() === lastLayers.open) return lastLayers
    lastLayers = { layers: same ? lastLayers.layers : list, current: interp.layer, open: panelOpen.get() }
    return lastLayers
  }
  const layers = derivedStore(
    layersNow,
    { subscribe: (fn) => doc.layers.onChange(fn) },
    { subscribe: (fn) => interp.onChange(fn) },
    panelOpen,
  )
  const layerActions: LayerActions = {
    setCurrent: (i) => {
      interp.layer = i
    },
    update: (i, patch) => doc.layers.update(i, patch),
    add() {
      let n = 1
      while (doc.layers.indexOf(`Layer${n}`) !== -1) n++
      interp.layer = doc.layers.add({ name: `Layer${n}`, color: 7, visible: true, locked: false })
    },
    toggle: () => panelOpen.set(!panelOpen.get()),
  }
  const submit = (): void => {
    const text = buffer.get()
    buffer.set('')
    interp.feedText(text)
  }
  const idle = (): boolean => interp.command === null
  /** A command from a shortcut: it ends the one under way, as picking from a menu does in AutoCAD. */
  const run = (name: string): void => {
    if (!idle()) interp.cancel()
    interp.feedText(name)
  }
  const detachKeyboard = attachKeyboard(window, {
    buffer: buffer.get,
    setBuffer: buffer.set,
    submit: (text) => interp.feedText(text),
    cancel: () => interp.cancel(),
    undo: () => idle() && interp.feedText('U'),
    redo: () => idle() && interp.feedText('REDO'),
    erase: () => idle() && selection.ids.size > 0 && interp.feedText('ERASE'),
    toggleHistory,
    toggle,
    run,
    literalSpace: () => interp.request?.kind === 'text' && interp.request.spaces === true,
  })

  const measure = (entries?: ResizeObserverEntry[]): void => {
    const dpr = window.devicePixelRatio
    // The device-pixel box is exact; clientWidth is an integer and is off by 1 px at fractional scales.
    const box = entries?.[0]?.devicePixelContentBoxSize?.[0]
    const width = box ? box.inlineSize / dpr : canvas.clientWidth
    const height = box ? box.blockSize / dpr : canvas.clientHeight
    backend.resize(width, height, dpr)
    overlay.width = Math.max(1, Math.round(width * dpr))
    overlay.height = Math.max(1, Math.round(height * dpr))
    setView(view ? { ...view, width, height, dpr } : fit({ cx: 0, cy: 0, scale: 1, width, height, dpr }, docExtents(doc) ?? DEFAULT_EXTENTS, FIT_MARGIN_PX))
    // Resizing a canvas clears it, so draw in the same task or it flashes.
    loop.flush()
  }
  const observer = new ResizeObserver((entries) => measure(entries))
  observer.observe(canvas, { box: 'device-pixel-content-box' })
  measure()
  void files?.openInitial()

  const detachInput = attachInput(canvas, {
    getView: () => view!,
    setView,
    extents: () => docExtents(doc),
    click: (sx, sy, shift) => {
      // DTEXT: a click ends the line being typed where it is, then the next one starts at the click.
      const r = interp.request
      if (r?.kind === 'text' && r.acceptPoint === true && buffer.get() !== '') submit()
      interp.feedPoint(screenToWorld(view!, sx, sy), shift)
    },
    enter: submit,
    hover: (p) => {
      // Off the viewport (over the command line, the status bar) the crosshair goes, but the last point stays for
      // the rubber band and for a distance typed in its direction.
      inside = p !== null
      if (p) {
        cursor = p
        interp.cursor = screenToWorld(view!, p.x, p.y)
      }
      tracking.set(tracking.get() + 1)
      loop.invalidate()
    },
  })

  return {
    commandLine,
    status,
    file: files?.state ?? null,
    layers,
    layerActions,
    active,
    settings,
    settingsActions,
    runCommand(inputs) {
      const [name, ...answers] = inputs
      if (name === undefined) return
      run(name)
      for (const a of answers) interp.feedText(a)
    },
    toggleHistory,
    toggle,
    dispose() {
      view = null // a frame still pending must not draw on a disposed backend
      detachInput()
      detachKeyboard()
      observer.disconnect()
      commandLine.dispose()
      active.dispose()
      status.dispose()
      layers.dispose()
      offGrid()
      offInterp()
      offDoc()
      offLayers()
      offRestore()
      offSelection()
      files?.dispose()
      index.dispose()
      scene.dispose()
      backend.dispose()
    },
  }
}
