import { BUILTIN_COMMANDS } from '../kernel/command/commands'
import { createInterpreter, type InterpreterHost } from '../kernel/command/runtime'
import { createDocument, docExtents, type Layer } from '../kernel/document'
import type { Vec2 } from '../kernel/geom/vec'
import { pick, pickBox } from '../kernel/pick'
import { createSelection } from '../kernel/selection'
import { APERTURE_PX, SNAP, snap } from '../kernel/snap'
import { createSpatialIndex } from '../kernel/spatial'
import { FIT_MARGIN_PX, fit, screenToWorld, type ViewState } from '../kernel/view'
import { drawOverlay, type OverlayTheme } from '../render/overlay'
import { createScene } from '../render/scene'
import { createWebGL2Backend } from '../render/webgl2/backend'
import { createFiles, type FileState } from './files'
import { attachInput, attachKeyboard } from './input'
import { parseInWorker } from './parse-worker'
import { createStore, derivedStore, type Store } from './stores'
import { packRgba, readBackendTheme, readCssColor } from './theme'

/** Half side of the pick box, CSS px. */
export const PICKBOX_PX = 5

/** What an empty drawing frames: an A3 sheet in millimetres, like AutoCAD's metric limits. */
const DEFAULT_EXTENTS = { minX: 0, minY: 0, maxX: 420, maxY: 297 }

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

export interface AppSession {
  commandLine: Store<CommandLineState>
  status: Store<StatusState>
  /** The drawing's file; null where there are no files (a plain browser). */
  file: Store<FileState> | null
  layers: Store<LayersState>
  layerActions: LayerActions
  toggleHistory(): void
  toggle(setting: Setting): void
  dispose(): void
}

/** The object snap modes in use (OSMODE); the settings (T40) will make them editable. QUA, NEA and NOD wait there. */
const SNAP_MODES = SNAP.END | SNAP.MID | SNAP.CEN | SNAP.INT | SNAP.PER

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
  const scene = createScene(doc, backend, {
    drawColor: packRgba(readCssColor(canvas, '--draw')),
    highlightColor: packRgba(readCssColor(canvas, '--accent')),
  })
  const index = createSpatialIndex(doc)
  const selection = createSelection()

  let view: ViewState | null = null
  let cursor: Vec2 | null = null // CSS px over the viewport; kept when it leaves, for the rubber band
  let inside = false
  let sceneDirty = true

  const host: InterpreterHost = {
    getView: () => view!,
    setView: (v) => setView(v),
    extents: () => docExtents(doc),
    pick: (p) => pick(doc, index, p, PICKBOX_PX / view!.scale),
    pickBox: (b, crossing) => pickBox(doc, index, b, crossing),
    snap: (p, base) => snap(doc, index, p, view!, SNAP_MODES, APERTURE_PX, base),
    query: (b) => index.query(b),
  }
  const interp = createInterpreter(doc, selection, { commands: BUILTIN_COMMANDS, host })
  const frame = (): void => {
    if (view) setView(fit(view, docExtents(doc) ?? DEFAULT_EXTENTS, FIT_MARGIN_PX))
  }
  const files = window.royale
    ? createFiles({
        api: window.royale,
        doc,
        parse: parseInWorker,
        print: (line) => interp.print(line),
        replaced: (currentLayer) => {
          selection.clear()
          const i = currentLayer === null ? -1 : doc.layers.indexOf(currentLayer)
          interp.layer = i >= 0 ? i : 0
          frame()
        },
        currentLayer: () => doc.layers.get(interp.layer)!.name,
      })
    : null
  if (files) host.files = files
  const panelOpen = createStore(false)
  host.showLayers = () => panelOpen.set(true)

  const loop = createFrameLoop(
    (cb) => requestAnimationFrame(cb),
    () => {
      if (!view) return
      if (sceneDirty) {
        sceneDirty = false
        backend.frame(view, scene.draws(view))
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
  function setView(v: ViewState): void {
    view = v
    interp.cursor = cursor && screenToWorld(v, cursor.x, cursor.y)
    // The same screen point is somewhere else in the world now: the status must say where.
    tracking.set(tracking.get() + 1)
    redrawScene()
  }

  const offDoc = doc.onChange((c) => {
    if (c.removed.length > 0) selection.remove(c.removed.map((e) => e.id))
    redrawScene()
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
    click: (sx, sy, shift) => interp.feedPoint(screenToWorld(view!, sx, sy), shift),
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
    toggleHistory,
    toggle,
    dispose() {
      view = null // a frame still pending must not draw on a disposed backend
      detachInput()
      detachKeyboard()
      observer.disconnect()
      commandLine.dispose()
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
