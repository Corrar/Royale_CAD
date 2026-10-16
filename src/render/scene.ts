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
}

export interface Scene {
  /** Brings the GPU up to date with the document and returns the draws that can reach the view. */
  draws(view: ViewState): Draw[]
  dispose(): void
}

export const LINE_WIDTH_PX = 1
/** A zeroed slot reads as this style, so a freed slot is invisible instead of a point at (0, 0). */
export const HIDDEN_STYLE = 0
const FIRST_STYLE = 1

type Kind = 'segment' | 'arc'
const WORDS: Record<Kind, number> = { segment: SEGMENT_STRIDE / 4, arc: ARC_STRIDE / 4 }
const SLOTS = 2 ** 24 // handle = pool index · SLOTS + slot
const OPEN_CAPACITY = 256
const DIRTY_LIST = 64
/** Edits beyond these sizes rebuild the packed pools instead of filling the open ones. */
const BULK_MIN = 16384
const OPEN_MIN = 65536

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
  let pools: Pool[] = []
  let open = new Map<string, Pool>()
  let openLive = 0
  let packedLive = 0
  let holes = 0
  let needsRebuild = doc.size > 0
  let disposed = false

  // Handles per entity id: one[id] = handle + 1 for a single primitive, -1 when the list is in `multi`, 0 for none.
  let one = new Float64Array(1024)
  let multi = new Map<number, number[]>()

  function addHandle(id: number, h: number): void {
    if (id >= one.length) {
      const grown = new Float64Array(Math.max(2 * one.length, id + 1))
      grown.set(one)
      one = grown
    }
    const v = one[id]!
    if (v === 0) one[id] = h + 1
    else if (v > 0) {
      multi.set(id, [v - 1, h])
      one[id] = -1
    } else multi.get(id)!.push(h)
  }

  function takeHandles(id: number): number[] {
    const v = one[id] ?? 0
    if (v === 0) return []
    one[id] = 0
    if (v > 0) return [v - 1]
    const list = multi.get(id)!
    multi.delete(id)
    return list
  }

  // --- styles: row 0 hidden, then one row per (layer, color) in use -------------------------------------------
  let table = new Uint32Array(64 * STYLE_WORDS)
  let styleCount = FIRST_STYLE
  let stylesDirty = true
  const styleByKey = new Map<number, number>()
  const styleLayer: number[] = [-1]
  const styleColor: (Color | undefined)[] = [undefined]

  const rgbaOf = (c: Color): number => (c === ACI_DEFAULT ? opts.drawColor : ((colorRgb(c) << 8) | 0xff) >>> 0)

  function writeRow(id: number): void {
    const l = doc.layers.get(styleLayer[id]!)!
    writeStyle(table, id, rgbaOf(styleColor[id] ?? l.color), LINE_WIDTH_PX, l.visible)
    stylesDirty = true
  }

  function styleOf(e: Entity): number {
    // Colors fit in 25 bits and 0 is not a color, so it stands for ByLayer.
    const key = e.layer * 2 ** 25 + (e.color ?? 0)
    let id = styleByKey.get(key)
    if (id === undefined) {
      id = styleCount++
      if (styleCount * STYLE_WORDS > table.length) {
        const t = new Uint32Array(2 * table.length)
        t.set(table)
        table = t
      }
      styleByKey.set(key, id)
      styleLayer[id] = e.layer
      styleColor[id] = e.color
      writeRow(id)
    }
    return id
  }

  const offLayers = doc.layers.onChange((index) => {
    for (let id = FIRST_STYLE; id < styleCount; id++) if (styleLayer[id] === index) writeRow(id)
  })

  // --- pools --------------------------------------------------------------------------------------------------
  function createPool(kind: Kind, band: number, packed: boolean, capacity: number): Pool {
    const buf = new ArrayBuffer(capacity * WORDS[kind] * 4)
    const p: Pool = {
      index: pools.length, kind, band, packed, batch: backend.createBatch(kind, capacity), capacity, count: 0, live: 0,
      f32: new Float32Array(buf), u32: new Uint32Array(buf), owner: new Uint32Array(capacity), free: [],
      dirty: [], ranged: false, dirtyLo: Infinity, dirtyHi: 0, buckets: [],
    }
    pools.push(p)
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
    addHandle(id, p.index * SLOTS + slot)
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

  function onChange(c: Change): void {
    if (needsRebuild) return
    if (c.added.length + c.changed.length > Math.max(BULK_MIN, doc.size / 4)) {
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

  /** Packs rows of `cols` (all when rows is null) into a new pool, in Hilbert order of their bbox centres. */
  function pack(kind: Kind, band: number, cols: Columns, rows: Uint32Array | null): void {
    const n = rows ? rows.length : cols.n
    if (n === 0) return
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
    const order = hilbertOrder(cx, cy, n)
    const p = createPool(kind, band, true, n)
    const size = bucketSize(n)
    let bucket = emptyBucket()
    for (let slot = 0; slot < n; slot++) {
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
      addHandle(cols.owner[i]!, p.index * SLOTS + slot)
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
    packedLive += n
    markDirty(p, 0, n)
  }

  function rebuild(): void {
    for (const p of pools) backend.destroyBatch(p.batch)
    pools = []
    open = new Map()
    one = new Float64Array(one.length)
    multi = new Map()
    openLive = 0
    packedLive = 0
    holes = 0
    const segs = new Columns(4, Math.max(16, doc.size))
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
    for (const e of doc.entities()) {
      style = styleOf(e)
      owner = e.id
      typeOf(e).primitives(e, 0, sink)
    }
    pack('segment', 0, segs, null)
    const byBand = new Map<number, number[]>()
    for (let i = 0; i < arcs.n; i++) {
      const band = bandOf(arcs.v[5 * i + 2]!)
      let rows = byBand.get(band)
      if (!rows) byBand.set(band, (rows = []))
      rows.push(i)
    }
    for (const band of [...byBand.keys()].sort((a, b) => a - b)) pack('arc', band, arcs, Uint32Array.from(byBand.get(band)!))
    needsRebuild = false
  }

  // --- f64 re-emission of primitives too big for the shader ---------------------------------------------------
  let clip: { batch: BatchId; capacity: number; f32: Float32Array; u32: Uint32Array } | null = null
  let clipCount = 0

  function pushClip(x0: number, y0: number, x1: number, y1: number, style: number): void {
    if (!clip || clipCount === clip.capacity) {
      const capacity = clip ? 2 * clip.capacity : OPEN_CAPACITY
      const buf = new ArrayBuffer(capacity * SEGMENT_STRIDE)
      if (clip) new Uint8Array(buf).set(new Uint8Array(clip.f32.buffer))
      if (clip) backend.destroyBatch(clip.batch)
      clip = { batch: backend.createBatch('segment', capacity), capacity, f32: new Float32Array(buf), u32: new Uint32Array(buf) }
    }
    writeSegment(clip.f32, clip.u32, clipCount++, x0, y0, x1, y1, style)
  }

  /**
   * Appends a draw of the visible primitives whose extent on screen is past half the shader's limit, clipped to
   * `rect` and flattened in f64. Between half and the full limit both copies draw, over the same pixels.
   */
  function clipPass(view: ViewState, rect: BBox, out: Draw[]): void {
    const ppu = view.scale * view.dpr
    const segLimit = MAX_SEGMENT_PX / 2 / ppu
    const arcLimit = MAX_ARC_RADIUS_PX / 2 / ppu
    const ids = new Set<number>()
    for (const p of pools) {
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
    if (ids.size === 0) return
    clipCount = 0
    for (const id of ids) {
      const e = doc.get(id)!
      const style = styleOf(e)
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
    if (clipCount === 0) return
    backend.writeBatch(clip!.batch, 0, clip!.u32.subarray(0, clipCount * WORDS.segment))
    out.push({ batch: clip!.batch, first: 0, count: clipCount })
  }

  return {
    draws(view) {
      if (disposed) throw new Error('the scene is disposed')
      if (needsRebuild) rebuild()
      for (const p of pools) flush(p)
      if (stylesDirty) {
        backend.setStyleTable(table.subarray(0, styleCount * STYLE_WORDS))
        stylesDirty = false
      }
      const ppu = view.scale * view.dpr
      // The stroke reaches half its width past the geometry; one more px covers antialiasing.
      const margin = (LINE_WIDTH_PX / 2 + 1) / view.scale
      const halfW = view.width / 2 / view.scale + margin
      const halfH = view.height / 2 / view.scale + margin
      const rect = { minX: view.cx - halfW, minY: view.cy - halfH, maxX: view.cx + halfW, maxY: view.cy + halfH }
      const out: Draw[] = []
      for (const p of pools) {
        if (p.live === 0) continue
        const subdiv = p.kind === 'arc' ? arcSubdiv(2 ** (p.band + 1) * ppu) : undefined
        for (const b of p.buckets) {
          if (b.count === 0 || !intersects(b, rect)) continue
          const last = out[out.length - 1]
          if (last && last.batch === p.batch && last.first + last.count === b.first) last.count += b.count
          else out.push(subdiv === undefined ? { batch: p.batch, first: b.first, count: b.count } : { batch: p.batch, first: b.first, count: b.count, subdiv })
        }
      }
      clipPass(view, rect, out)
      return out
    },

    dispose() {
      if (disposed) return
      disposed = true
      offDoc()
      offLayers()
      for (const p of pools) backend.destroyBatch(p.batch)
      if (clip) backend.destroyBatch(clip.batch)
      pools = []
      clip = null
    },
  }
}
