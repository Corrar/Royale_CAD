import { ACI_DEFAULT, colorRgb, type Color } from '../kernel/color'
import type { Change, Document } from '../kernel/document'
import { typeOf } from '../kernel/entity/registry'
import type { Entity, PrimSink } from '../kernel/entity/types'
import { arcSpansInBox, clipSegment } from '../kernel/geom/clip'
import { arcBBox } from '../kernel/geom/curve'
import { hilbertOrder } from '../kernel/geom/hilbert'
import type { BBox } from '../kernel/geom/vec'
import type { ViewState } from '../kernel/view'
import {
  ARC_STRIDE, MAX_ARC_RADIUS_PX, MAX_SEGMENT_PX, SEGMENT_STRIDE, STYLE_WORDS, arcSubdiv, writeArc, writeSegment, writeStyle,
  type BatchId, type Draw, type RenderBackend,
} from './backend'

export interface SceneOptions {
  /** 0xRRGGBBAA for ACI 7, the color that follows the background. */
  drawColor: number
  /** 0xRRGGBBAA of highlighted (selected) entities. */
  highlightColor: number
  /** From this many entities a rebuild runs in slices (draws, build; default 20 000); below, all at once. */
  sliceFrom?: number
}

export interface Scene {
  /** Brings the GPU up to date with the document and returns the draws that can reach the view. */
  draws(view: ViewState): Draw[]
  /**
   * A big rebuild under way or waiting to begin, a slice per draws() or build(): the caller keeps calling until it
   * ends. Meanwhile the draws show the drawing as it was before.
   */
  readonly building: boolean
  /**
   * Works on the rebuild due for up to ms, between frames: when frames are slow (a software GPU), a slice per
   * frame would make a big rebuild wait on them. A big rebuild begins only on a call without changes since the last.
   */
  build(ms: number): void
  /** Entities drawn again on top, in the highlight style. Ids not in the document are ignored. */
  setHighlight(ids: Iterable<number>): void
  dispose(): void
}

export const LINE_WIDTH_PX = 1
export const HIGHLIGHT_WIDTH_PX = 2
/** A zeroed slot reads as this style, so a freed slot is invisible instead of a point at (0, 0). */
export const HIDDEN_STYLE = 0
export const HIGHLIGHT_STYLE = 1
const FIRST_STYLE = 2

type Kind = 'segment' | 'arc'
const WORDS: Record<Kind, number> = { segment: SEGMENT_STRIDE / 4, arc: ARC_STRIDE / 4 }
const SLOTS = 2 ** 32 // handle = pool index · SLOTS + slot; exact in f64 up to 2^21 pools
const OPEN_CAPACITY = 256
const DIRTY_LIST = 64
/** Edits beyond these sizes rebuild the packed pools instead of filling the open ones. */
const BULK_MIN = 16384
const OPEN_MIN = 65536
/** From this many entities a rebuild runs in slices instead of all at once (SceneOptions.sliceFrom). */
const SLICE_FROM = 20_000
/** The time a slice of rebuild may take in one draws(), ms. */
const BUILD_SLICE_MS = 8
/** Entities gathered, or slots packed, between looks at the clock. */
const GATHER_STEP = 2048
const PACK_STEP = 8192

/** Runs a sliced task to its end in one go. */
function drain<T>(g: Generator<void, T>): T {
  for (;;) {
    const r = g.next()
    if (r.done) return r.value
  }
}

/** Handles per entity id: one[id] = handle + 1 for a single primitive, -1 when the list is in `multi`, 0 for none. */
interface Handles { one: Float64Array; multi: Map<number, number[]> }

/** Style rows: 0 hidden, 1 highlight, then one per (layer, color) in use. */
interface Styles { table: Uint32Array; count: number; byKey: Map<number, number>; layer: number[]; color: (Color | undefined)[] }

/** What a rebuild makes, put in place of the current pools in one go. */
interface Generation { pools: Pool[]; handles: Handles; styles: Styles; packedLive: number }

/** A run of slots with the bounds of their primitives; extent is a segment's length or an arc's radius. */
interface Bucket { first: number; count: number; minX: number; minY: number; maxX: number; maxY: number; maxExtent: number }

/**
 * One backend batch and its CPU copy. Packed pools hold the primitives present at the last rebuild, sorted along
 * the Hilbert curve and cut into buckets for culling; their freed slots stay as hidden holes. Open pools take
 * later additions, grow by doubling and reuse freed slots; they have a single bucket.
 */
interface Pool {
  index: number
  kind: Kind
  band: number // arcs: floor(log2 r)
  packed: boolean
  batch: BatchId
  capacity: number
  count: number
  live: number
  f32: Float32Array
  u32: Uint32Array
  owner: Uint32Array
  free: number[]
  dirty: number[]
  ranged: boolean // too many scattered slots: upload [dirtyLo, dirtyHi) instead
  dirtyLo: number
  dirtyHi: number
  buckets: Bucket[]
}

const emptyBucket = (): Bucket => ({ first: 0, count: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, maxExtent: 0 })

const bandOf = (r: number): number => Math.floor(Math.log2(r))

/** Instances per culling bucket of a packed pool: about 256 buckets, within [1024, 65536]. */
const bucketSize = (n: number): number => Math.min(65536, Math.max(1024, 2 ** Math.ceil(Math.log2(Math.max(1, n) / 256))))

const intersects = (b: Bucket, r: BBox): boolean => b.minX <= r.maxX && r.minX <= b.maxX && b.minY <= r.maxY && r.minY <= b.maxY

/** Growable columns of primitives collected for a rebuild. */
class Columns {
  n = 0
  v: Float64Array
  style: Uint32Array
  owner: Uint32Array
  constructor(readonly width: number, capacity: number) {
    this.v = new Float64Array(width * capacity)
    this.style = new Uint32Array(capacity)
    this.owner = new Uint32Array(capacity)
  }
  /** Returns the index of a fresh row. */
  push(style: number, owner: number): number {
    if (this.n === this.style.length) {
      const capacity = 2 * this.n
      const grow = <T extends Float64Array | Uint32Array>(a: T, k: number): T => {
        const b = new (a.constructor as new (n: number) => T)(k * capacity)
        b.set(a)
        return b
      }
      this.v = grow(this.v, this.width)
      this.style = grow(this.style, 1)
      this.owner = grow(this.owner, 1)
    }
    this.style[this.n] = style
    this.owner[this.n] = owner
    return this.n++
  }
}

export function createScene(doc: Document, backend: RenderBackend, opts: SceneOptions): Scene {
  let pools: Pool[] = [] // index = the pool part of a handle
  let hlPools: Pool[] = []
  let highlight = new Set<number>()
  let hlDirty = false
  let open = new Map<string, Pool>()
  let openLive = 0
  let packedLive = 0
  let holes = 0
  let needsRebuild = doc.size > 0
  let disposed = false
  /** A rebuild in slices; its result goes in place when it ends. */
  let building: Generator<void, Generation> | null = null
  /** The pools the sliced rebuild has made so far, destroyed if it is dropped. */
  let buildingPools: Pool[] = []
  /** The document changed since the last draws() or build(). */
  let changed = false

  let handles: Handles = { one: new Float64Array(1024), multi: new Map() }

  function addHandle(hs: Handles, id: number, h: number): void {
    if (id >= hs.one.length) {
      const grown = new Float64Array(Math.max(Math.ceil(1.5 * hs.one.length), id + 1))
      grown.set(hs.one)
      hs.one = grown
    }
    const v = hs.one[id]!
    if (v === 0) hs.one[id] = h + 1
    else if (v > 0) {
      hs.multi.set(id, [v - 1, h])
      hs.one[id] = -1
    } else hs.multi.get(id)!.push(h)
  }

  function takeHandles(id: number): number[] {
    const { one, multi } = handles
    const v = one[id] ?? 0
    if (v === 0) return []
    one[id] = 0
    if (v > 0) return [v - 1]
    const list = multi.get(id)!
    multi.delete(id)
    return list
  }

  // --- styles: row 0 hidden, then one row per (layer, color) in use -------------------------------------------
  let stylesDirty = true
  const newStyles = (): Styles => {
    const st: Styles = { table: new Uint32Array(64 * STYLE_WORDS), count: FIRST_STYLE, byKey: new Map(), layer: [-1, -1], color: [undefined, undefined] }
    writeStyle(st.table, HIGHLIGHT_STYLE, opts.highlightColor, HIGHLIGHT_WIDTH_PX, true)
    return st
  }
  let styles = newStyles()
  // The rows of a sliced rebuild, which go in place with its pools.
  let buildingStyles: Styles | null = null

  const rgbaOf = (c: Color): number => (c === ACI_DEFAULT ? opts.drawColor : ((colorRgb(c) << 8) | 0xff) >>> 0)

  function writeRow(st: Styles, id: number): void {
    const l = doc.layers.get(st.layer[id]!)!
    writeStyle(st.table, id, rgbaOf(st.color[id] ?? l.color), LINE_WIDTH_PX, l.visible)
    if (st === styles) stylesDirty = true
  }

  function styleIn(st: Styles, e: Entity): number {
    // Colors fit in 25 bits and 0 is not a color, so it stands for ByLayer.
    const key = e.layer * 2 ** 25 + (e.color ?? 0)
    let id = st.byKey.get(key)
    if (id === undefined) {
      id = st.count++
      if (st.count * STYLE_WORDS > st.table.length) {
        const t = new Uint32Array(2 * st.table.length)
        t.set(st.table)
        st.table = t
      }
      st.byKey.set(key, id)
      st.layer[id] = e.layer
      st.color[id] = e.color
      writeRow(st, id)
    }
    return id
  }
  const styleOf = (e: Entity): number => styleIn(styles, e)

  const offLayers = doc.layers.onChange((index) => {
    for (const st of buildingStyles ? [styles, buildingStyles] : [styles]) {
      for (let id = FIRST_STYLE; id < st.count; id++) if (st.layer[id] === index) writeRow(st, id)
    }
    if (highlight.size > 0) hlDirty = true // hidden layers drop out of the highlight
  })

  // --- pools --------------------------------------------------------------------------------------------------
  function createPool(kind: Kind, band: number, packed: boolean, capacity: number, into = pools): Pool {
    const buf = new ArrayBuffer(capacity * WORDS[kind] * 4)
    const p: Pool = {
      index: into.length, kind, band, packed, batch: backend.createBatch(kind, capacity), capacity, count: 0, live: 0,
      f32: new Float32Array(buf), u32: new Uint32Array(buf), owner: new Uint32Array(capacity), free: [],
      dirty: [], ranged: false, dirtyLo: Infinity, dirtyHi: 0, buckets: [],
    }
    into.push(p)
    return p
  }

  function markDirty(p: Pool, lo: number, hi = lo + 1): void {
    p.dirtyLo = Math.min(p.dirtyLo, lo)
    p.dirtyHi = Math.max(p.dirtyHi, hi)
    if (hi - lo > 1 || p.dirty.length >= DIRTY_LIST) p.ranged = true
    else if (!p.ranged) p.dirty.push(lo)
  }

  function flush(p: Pool): void {
    if (p.dirtyHi <= p.dirtyLo) return
    const words = WORDS[p.kind]
    const write = (lo: number, hi: number): void => backend.writeBatch(p.batch, lo, p.u32.subarray(lo * words, hi * words))
    if (p.ranged) write(p.dirtyLo, p.dirtyHi)
    else {
      const slots = [...new Set(p.dirty)].sort((a, b) => a - b)
      let lo = slots[0]!
      let hi = lo + 1
      for (let i = 1; i < slots.length; i++) {
        if (slots[i] === hi) hi++
        else {
          write(lo, hi)
          lo = slots[i]!
          hi = lo + 1
        }
      }
      write(lo, hi)
    }
    p.dirty.length = 0
    p.ranged = false
    p.dirtyLo = Infinity
    p.dirtyHi = 0
  }

  function openPool(kind: Kind, band: number): Pool {
    const key = kind === 'segment' ? kind : `arc ${band}`
    let p = open.get(key)
    if (!p) {
      p = createPool(kind, band, false, OPEN_CAPACITY)
      p.buckets.push(emptyBucket())
      open.set(key, p)
    }
    return p
  }

  function grow(p: Pool): void {
    const capacity = 2 * p.capacity
    const buf = new ArrayBuffer(capacity * WORDS[p.kind] * 4)
    const f32 = new Float32Array(buf)
    f32.set(p.f32)
    const owner = new Uint32Array(capacity)
    owner.set(p.owner)
    const batch = backend.createBatch(p.kind, capacity)
    backend.destroyBatch(p.batch)
    Object.assign(p, { capacity, batch, f32, u32: new Uint32Array(buf), owner })
    markDirty(p, 0, p.count)
  }

  /** Takes a slot of the open pool for (kind, band), runs write on it, and records it for entity id. */
  function place(kind: Kind, band: number, id: number, b: BBox, extent: number, write: (p: Pool, slot: number) => void): void {
    const p = openPool(kind, band)
    let slot = p.free.pop()
    if (slot === undefined) {
      if (p.count === p.capacity) grow(p)
      slot = p.count++
    }
    write(p, slot)
    p.owner[slot] = id
    p.live++
    openLive++
    addHandle(handles, id, p.index * SLOTS + slot)
    markDirty(p, slot)
    const k = p.buckets[0]!
    k.count = p.count
    k.minX = Math.min(k.minX, b.minX)
    k.minY = Math.min(k.minY, b.minY)
    k.maxX = Math.max(k.maxX, b.maxX)
    k.maxY = Math.max(k.maxY, b.maxY)
    k.maxExtent = Math.max(k.maxExtent, extent)
  }

  function addEntity(e: Entity): void {
    const style = styleOf(e)
    typeOf(e).primitives(e, 0, {
      segment(x0, y0, x1, y1) {
        const b = { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) }
        place('segment', 0, e.id, b, Math.hypot(x1 - x0, y1 - y0), (p, s) => writeSegment(p.f32, p.u32, s, x0, y0, x1, y1, style))
      },
      arc(cx, cy, r, a0, sweep) {
        place('arc', bandOf(r), e.id, arcBBox(cx, cy, r, a0, sweep), r, (p, s) => writeArc(p.f32, p.u32, s, cx, cy, r, a0, sweep, style))
      },
    })
  }

  function removeEntity(id: number): void {
    for (const h of takeHandles(id)) {
      const p = pools[Math.floor(h / SLOTS)]!
      const slot = h % SLOTS
      const words = WORDS[p.kind]
      p.u32[slot * words + words - 1] = HIDDEN_STYLE
      p.owner[slot] = 0
      p.live--
      markDirty(p, slot)
      if (p.packed) {
        packedLive--
        holes++
      } else {
        openLive--
        p.free.push(slot)
      }
    }
  }

  /** Drops a sliced rebuild: the document changed under it. The next draws() begins another. */
  function abortBuild(): void {
    for (const p of buildingPools) backend.destroyBatch(p.batch)
    buildingPools = []
    buildingStyles = null
    building = null
  }

  function onChange(c: Change): void {
    changed = true
    if (highlight.size > 0 && !hlDirty) {
      const touches = (e: Entity): boolean => highlight.has(e.id)
      hlDirty = c.added.some(touches) || c.removed.some(touches) || c.changed.some(([, e]) => touches(e))
    }
    if (building) abortBuild()
    if (needsRebuild) return
    if (c.bulk || c.added.length + c.changed.length > Math.max(BULK_MIN, doc.size / 4)) {
      needsRebuild = true
      return
    }
    for (const e of c.removed) removeEntity(e.id)
    for (const [prev, next] of c.changed) {
      removeEntity(prev.id)
      addEntity(next)
    }
    for (const e of c.added) addEntity(e)
    if (openLive > Math.max(OPEN_MIN, packedLive / 4) || holes > Math.max(OPEN_MIN, packedLive / 2)) needsRebuild = true
  }
  const offDoc = doc.onChange(onChange)
  // The GPU came back empty: upload everything again with the next draws().
  const offRestore = backend.onRestore(() => {
    for (const p of [...pools, ...hlPools]) if (p.count > 0) markDirty(p, 0, p.count)
    stylesDirty = true
  })

  /**
   * Packs rows of `cols` (all when rows is null) into a new pool of `into`, in Hilbert order of their bbox centres,
   * yielding now and then. Handles go to `hs` (the main pools only). Returns how many it packed.
   */
  function* pack(kind: Kind, band: number, cols: Columns, rows: Uint32Array | null, into: Pool[], hs: Handles | null): Generator<void, number> {
    const n = rows ? rows.length : cols.n
    if (n === 0) return 0
    const row = (k: number): number => (rows ? rows[k]! : k)
    const w = cols.width
    const v = cols.v
    const cx = new Float64Array(n)
    const cy = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      const o = w * row(k)
      cx[k] = kind === 'segment' ? v[o]! + v[o + 2]! : v[o]!
      cy[k] = kind === 'segment' ? v[o + 1]! + v[o + 3]! : v[o + 1]!
    }
    yield
    const order = hilbertOrder(cx, cy, n)
    yield
    const p = createPool(kind, band, true, n, into)
    const size = bucketSize(n)
    let bucket = emptyBucket()
    for (let slot = 0; slot < n; slot++) {
      if (slot % PACK_STEP === PACK_STEP - 1) yield
      const i = row(order[slot]!)
      const o = w * i
      let minX: number, minY: number, maxX: number, maxY: number, extent: number
      if (kind === 'segment') {
        const x0 = v[o]!
        const y0 = v[o + 1]!
        const x1 = v[o + 2]!
        const y1 = v[o + 3]!
        writeSegment(p.f32, p.u32, slot, x0, y0, x1, y1, cols.style[i]!)
        minX = Math.min(x0, x1)
        minY = Math.min(y0, y1)
        maxX = Math.max(x0, x1)
        maxY = Math.max(y0, y1)
        extent = Math.hypot(x1 - x0, y1 - y0)
      } else {
        const r = v[o + 2]!
        writeArc(p.f32, p.u32, slot, v[o]!, v[o + 1]!, r, v[o + 3]!, v[o + 4]!, cols.style[i]!)
        const b = arcBBox(v[o]!, v[o + 1]!, r, v[o + 3]!, v[o + 4]!)
        minX = b.minX
        minY = b.minY
        maxX = b.maxX
        maxY = b.maxY
        extent = r
      }
      p.owner[slot] = cols.owner[i]!
      if (hs) addHandle(hs, cols.owner[i]!, p.index * SLOTS + slot)
      if (bucket.count === size) {
        p.buckets.push(bucket)
        bucket = emptyBucket()
        bucket.first = slot
      }
      bucket.count++
      bucket.minX = Math.min(bucket.minX, minX)
      bucket.minY = Math.min(bucket.minY, minY)
      bucket.maxX = Math.max(bucket.maxX, maxX)
      bucket.maxY = Math.max(bucket.maxY, maxY)
      bucket.maxExtent = Math.max(bucket.maxExtent, extent)
    }
    p.buckets.push(bucket)
    p.count = n
    p.live = n
    markDirty(p, 0, n)
    return n
  }

  /** Gathers the primitives of `entities` and packs them into `into`, yielding now and then. Returns the count. */
  function* packAll(entities: Iterable<Entity>, styleFor: (e: Entity) => number, into: Pool[], sizeHint: number, hs: Handles | null): Generator<void, number> {
    const segs = new Columns(4, Math.max(16, sizeHint))
    const arcs = new Columns(5, 16)
    let style = 0
    let owner = 0
    const sink: PrimSink = {
      segment(x0, y0, x1, y1) {
        const o = 4 * segs.push(style, owner)
        segs.v[o] = x0
        segs.v[o + 1] = y0
        segs.v[o + 2] = x1
        segs.v[o + 3] = y1
      },
      arc(cx, cy, r, a0, sweep) {
        const o = 5 * arcs.push(style, owner)
        arcs.v[o] = cx
        arcs.v[o + 1] = cy
        arcs.v[o + 2] = r
        arcs.v[o + 3] = a0
        arcs.v[o + 4] = sweep
      },
    }
    let k = 0
    for (const e of entities) {
      if (++k % GATHER_STEP === 0) yield
      style = styleFor(e)
      owner = e.id
      typeOf(e).primitives(e, 0, sink)
    }
    let packed = yield* pack('segment', 0, segs, null, into, hs)
    const byBand = new Map<number, number[]>()
    for (let i = 0; i < arcs.n; i++) {
      const band = bandOf(arcs.v[5 * i + 2]!)
      let rows = byBand.get(band)
      if (!rows) byBand.set(band, (rows = []))
      rows.push(i)
    }
    for (const band of [...byBand.keys()].sort((a, b) => a - b)) packed += yield* pack('arc', band, arcs, Uint32Array.from(byBand.get(band)!), into, hs)
    return packed
  }

  /** A new generation of pools for every entity, with its own handles and style rows (re-keyed: unused rows go). */
  function* generation(into: Pool[]): Generator<void, Generation> {
    const st = newStyles()
    buildingStyles = st
    const hs: Handles = { one: new Float64Array(handles.one.length), multi: new Map() }
    const packedLive = yield* packAll(doc.entities(), (e) => styleIn(st, e), into, doc.size, hs)
    return { pools: into, handles: hs, styles: st, packedLive }
  }

  /** Puts a generation in place of the current pools. */
  function install(g: Generation): void {
    for (const p of pools) backend.destroyBatch(p.batch)
    pools = g.pools
    handles = g.handles
    styles = g.styles
    buildingStyles = null
    stylesDirty = true
    open = new Map()
    openLive = 0
    packedLive = g.packedLive
    holes = 0
    needsRebuild = false
  }

  /** All at once: the old pools go first, so the memory of both never adds up. */
  function rebuild(): void {
    for (const p of pools) backend.destroyBatch(p.batch)
    pools = []
    install(drain(generation([])))
  }

  /** A slice of the rebuild under way, ms long at most; the result goes in place when it ends. */
  function buildSlice(ms: number): void {
    const start = performance.now()
    for (;;) {
      const r = building!.next()
      if (r.done) {
        building = null
        buildingPools = []
        install(r.value)
        return
      }
      if (performance.now() - start >= ms) return
    }
  }

  /** Begins the rebuild due, if any, and works on a big one for up to ms. */
  function advance(ms: number): void {
    if (needsRebuild && !building) {
      if (doc.size < (opts.sliceFrom ?? SLICE_FROM)) rebuild()
      else if (!changed) {
        // Only without changes since the last call: while they keep coming (a file read in slices), the next one
        // would drop the rebuild and the batches it made.
        buildingPools = []
        building = generation(buildingPools)
      }
    }
    changed = false
    if (building) buildSlice(ms)
  }

  function rebuildHighlight(): void {
    for (const p of hlPools) backend.destroyBatch(p.batch)
    hlPools = []
    const shown: Entity[] = []
    for (const id of highlight) {
      const e = doc.get(id)
      if (e && doc.layers.get(e.layer)!.visible) shown.push(e)
    }
    drain(packAll(shown, () => HIGHLIGHT_STYLE, hlPools, shown.length, null))
    hlDirty = false
  }

  // --- f64 re-emission of primitives too big for the shader ---------------------------------------------------
  let clip: { batch: BatchId; capacity: number; f32: Float32Array; u32: Uint32Array } | null = null
  // Collected per frame before the batch is sized, so no draw can point at a batch replaced by a growth.
  let clipped = new Float64Array(5 * 64) // x0, y0, x1, y1, style
  let clipCount = 0

  function pushClip(x0: number, y0: number, x1: number, y1: number, style: number): void {
    if (5 * clipCount === clipped.length) {
      const grown = new Float64Array(2 * clipped.length)
      grown.set(clipped)
      clipped = grown
    }
    const o = 5 * clipCount++
    clipped[o] = x0
    clipped[o + 1] = y0
    clipped[o + 2] = x1
    clipped[o + 3] = y1
    clipped[o + 4] = style
  }

  /**
   * Collects, clipped to `rect` and flattened in f64, the visible primitives of `list` whose extent on screen is
   * past half the shader's limit. Between half and the full limit both copies draw, over the same pixels.
   */
  function collectClipped(list: readonly Pool[], view: ViewState, rect: BBox, styleFor: (e: Entity) => number): void {
    const ppu = view.scale * view.dpr
    const segLimit = MAX_SEGMENT_PX / 2 / ppu
    const arcLimit = MAX_ARC_RADIUS_PX / 2 / ppu
    const ids = new Set<number>()
    for (const p of list) {
      const limit = p.kind === 'segment' ? segLimit : arcLimit
      const words = WORDS[p.kind]
      const f = p.f32
      for (const b of p.buckets) {
        if (b.maxExtent <= limit || !intersects(b, rect)) continue
        for (let s = b.first; s < b.first + b.count; s++) {
          const w = s * words
          if (p.u32[w + words - 1] === HIDDEN_STYLE) continue
          // From the hi/lo pairs: off by ~x·2^-48, far below what decides here.
          const x0 = f[w]! + f[w + 1]!
          const y0 = f[w + 2]! + f[w + 3]!
          if (p.kind === 'segment') {
            const x1 = f[w + 4]! + f[w + 5]!
            const y1 = f[w + 6]! + f[w + 7]!
            if (Math.hypot(x1 - x0, y1 - y0) <= limit) continue
            if (Math.max(x0, x1) < rect.minX || Math.min(x0, x1) > rect.maxX || Math.max(y0, y1) < rect.minY || Math.min(y0, y1) > rect.maxY) continue
          } else {
            const r = f[w + 4]!
            if (r <= limit) continue
            // Skip circles apart from the view, and circles that enclose it without passing through it.
            if (x0 + r < rect.minX || x0 - r > rect.maxX || y0 + r < rect.minY || y0 - r > rect.maxY) continue
            const far = Math.hypot(Math.max(Math.abs(rect.minX - x0), Math.abs(rect.maxX - x0)), Math.max(Math.abs(rect.minY - y0), Math.abs(rect.maxY - y0)))
            if (far < r * (1 - 1e-6)) continue
          }
          ids.add(p.owner[s]!)
        }
      }
    }
    for (const id of ids) {
      const e = doc.get(id)!
      const style = styleFor(e)
      typeOf(e).primitives(e, 0, {
        segment(x0, y0, x1, y1) {
          if (Math.hypot(x1 - x0, y1 - y0) <= segLimit) return
          const c = clipSegment(rect, x0, y0, x1, y1)
          if (c) pushClip(c[0], c[1], c[2], c[3], style)
        },
        arc(cx, cy, r, a0, sweep) {
          if (r <= arcLimit) return
          const spans = arcSpansInBox(rect, cx, cy, r, a0, sweep)
          // Chords with a 0.25 px sagitta.
          const step = 2 * Math.acos(1 - 0.25 / (r * ppu))
          for (let k = 0; k < spans.length; k += 2) {
            const start = spans[k]!
            const len = spans[k + 1]!
            const n = Math.min(4096, Math.max(1, Math.ceil(len / step)))
            let px = cx + r * Math.cos(start)
            let py = cy + r * Math.sin(start)
            for (let i = 1; i <= n; i++) {
              const a = start + (len * i) / n
              const qx = cx + r * Math.cos(a)
              const qy = cy + r * Math.sin(a)
              pushClip(px, py, qx, qy, style)
              px = qx
              py = qy
            }
          }
        },
      })
    }
  }

  /** Uploads the collected segments; returns the clip batch, or null when there are none. */
  function uploadClipped(): BatchId | null {
    if (clipCount === 0) return null
    if (!clip || clip.capacity < clipCount) {
      if (clip) backend.destroyBatch(clip.batch)
      let capacity = clip?.capacity ?? OPEN_CAPACITY
      while (capacity < clipCount) capacity *= 2
      const buf = new ArrayBuffer(capacity * SEGMENT_STRIDE)
      clip = { batch: backend.createBatch('segment', capacity), capacity, f32: new Float32Array(buf), u32: new Uint32Array(buf) }
    }
    for (let i = 0; i < clipCount; i++) {
      const o = 5 * i
      writeSegment(clip.f32, clip.u32, i, clipped[o]!, clipped[o + 1]!, clipped[o + 2]!, clipped[o + 3]!, clipped[o + 4]!)
    }
    backend.writeBatch(clip.batch, 0, clip.u32.subarray(0, clipCount * WORDS.segment))
    return clip.batch
  }

  /** Appends the culled draws of `list`, merging buckets adjacent in the same batch. */
  function emitDraws(list: readonly Pool[], view: ViewState, rect: BBox, out: Draw[]): void {
    const ppu = view.scale * view.dpr
    for (const p of list) {
      if (p.live === 0) continue
      const subdiv = p.kind === 'arc' ? arcSubdiv(2 ** (p.band + 1) * ppu) : undefined
      for (const b of p.buckets) {
        if (b.count === 0 || !intersects(b, rect)) continue
        const last = out[out.length - 1]
        if (last && last.batch === p.batch && last.first + last.count === b.first) last.count += b.count
        else out.push(subdiv === undefined ? { batch: p.batch, first: b.first, count: b.count } : { batch: p.batch, first: b.first, count: b.count, subdiv })
      }
    }
  }

  return {
    draws(view) {
      if (disposed) throw new Error('the scene is disposed')
      advance(BUILD_SLICE_MS)
      if (hlDirty) rebuildHighlight()
      for (const p of pools) flush(p)
      for (const p of hlPools) flush(p)
      if (stylesDirty) {
        backend.setStyleTable(styles.table.subarray(0, styles.count * STYLE_WORDS))
        stylesDirty = false
      }
      // The stroke reaches half its width past the geometry; one more px covers antialiasing.
      const margin = (Math.max(LINE_WIDTH_PX, HIGHLIGHT_WIDTH_PX) / 2 + 1) / view.scale
      const halfW = view.width / 2 / view.scale + margin
      const halfH = view.height / 2 / view.scale + margin
      const rect = { minX: view.cx - halfW, minY: view.cy - halfH, maxX: view.cx + halfW, maxY: view.cy + halfH }
      clipCount = 0
      collectClipped(pools, view, rect, styleOf)
      const mainClipped = clipCount
      collectClipped(hlPools, view, rect, () => HIGHLIGHT_STYLE)
      const clipBatch = uploadClipped()
      // Order: the drawing, its clipped primitives, then the highlight on top with its own.
      const out: Draw[] = []
      emitDraws(pools, view, rect, out)
      if (clipBatch !== null && mainClipped > 0) out.push({ batch: clipBatch, first: 0, count: mainClipped })
      emitDraws(hlPools, view, rect, out)
      if (clipBatch !== null && clipCount > mainClipped) out.push({ batch: clipBatch, first: mainClipped, count: clipCount - mainClipped })
      return out
    },

    build(ms) {
      if (disposed) throw new Error('the scene is disposed')
      advance(ms)
    },

    get building() {
      return building !== null || (needsRebuild && doc.size >= (opts.sliceFrom ?? SLICE_FROM))
    },

    setHighlight(ids) {
      highlight = new Set(ids)
      hlDirty = true
    },

    dispose() {
      if (disposed) return
      disposed = true
      offDoc()
      offLayers()
      offRestore()
      abortBuild()
      for (const p of [...pools, ...hlPools]) backend.destroyBatch(p.batch)
      if (clip) backend.destroyBatch(clip.batch)
      pools = []
      hlPools = []
      clip = null
    },
  }
}
