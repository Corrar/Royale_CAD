import type { Document } from './document'
import { typeOf } from './entity/registry'
import type { Entity } from './entity/types'
import { hilbertFrame, hilbertKey, radixOrder, type HilbertFrame } from './geom/hilbert'
import { bboxEmpty, type BBox } from './geom/vec'

export interface SpatialIndex {
  /**
   * Ids of the entities whose bbox intersects or touches b, in no particular order. Reflects the document as of
   * its last change event: inside an open transaction the pending edits are not seen.
   */
  query(b: BBox): number[]
  /**
   * A cold build of a big tree (SpatialIndexOptions.sliceFrom) due or under way: the caller calls build() until it
   * ends. Meanwhile queries scan every bbox, exact but slower.
   */
  readonly building: boolean
  /**
   * Works on the cold build due, a step (a few thousand items) and then more while `more()` says so. A build begins
   * only on a call without changes since the last: while they keep coming (a file read in slices), the next one
   * would drop it.
   */
  build(more: () => boolean): void
  /** How many times the tree was rebuilt, and how many of those sorted everything; for tests and benchmarks. */
  readonly rebuilds: number
  readonly coldBuilds: number
  dispose(): void
}

export interface SpatialIndexOptions {
  /** Edits kept outside the tree before the next query rebuilds it. Default: max(4096, tree size / 64). */
  maxDirty?: number
  /** From this many entities a cold build goes in steps (build) instead of in the query. Default: SLICE_FROM. */
  sliceFrom?: number
}

const NODE = 16
/** From this many entities a cold build goes in steps (SpatialIndexOptions.sliceFrom). */
const SLICE_FROM = 20_000
/** Items between the yields of a cold build. */
const BUILD_STEP = 8192

/** Runs a generator to its end. */
function drain<T>(g: Generator<void, T>): T {
  for (;;) {
    const r = g.next()
    if (r.done) return r.value
  }
}

/**
 * Packed R-tree of n items. Level 0 holds the items sorted by the Hilbert key of their bbox centre (`keys`,
 * ascending, in `frame`); each node of level L + 1 bounds NODE consecutive nodes of level L. Level L has size[L]
 * nodes starting at node start[L] of `boxes`. The arrays may be longer than needed: they are recycled.
 */
interface Tree {
  n: number
  boxes: Float64Array
  ids: Float64Array
  keys: Uint32Array
  frame: HilbertFrame
  start: number[]
  size: number[]
}

/**
 * A tree for n items, reusing the arrays of `spare` when they are long enough. Fresh memory costs page faults
 * and, in a big heap, can trigger a full collection: a rebuild should allocate nothing large.
 */
function allocTree(n: number, frame: HilbertFrame, spare: Tree | null): Tree {
  const start: number[] = []
  const size: number[] = []
  let total = 0
  for (let s = n; ; s = Math.ceil(s / NODE)) {
    start.push(total)
    size.push(s)
    total += s
    if (s === 1) break
  }
  if (spare && spare.boxes.length >= 4 * total && spare.ids.length >= n) {
    return { n, boxes: spare.boxes, ids: spare.ids, keys: spare.keys, frame, start, size }
  }
  // Headroom so that a drawing that grows a little keeps its arrays.
  const cap = Math.ceil(n * 1.1) + 16
  return { n, boxes: new Float64Array(4 * Math.ceil(total * 1.1 + 16)), ids: new Float64Array(cap), keys: new Uint32Array(cap), frame, start, size }
}

/** Fills the levels above the leaves. */
function packLevels(t: Tree): void {
  const { boxes, start, size } = t
  for (let L = 1; L < start.length; L++) {
    const below = start[L - 1]!
    for (let p = 0; p < size[L]!; p++) {
      const last = Math.min((p + 1) * NODE, size[L - 1]!)
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let c = p * NODE; c < last; c++) {
        const o = 4 * (below + c)
        minX = Math.min(minX, boxes[o]!)
        minY = Math.min(minY, boxes[o + 1]!)
        maxX = Math.max(maxX, boxes[o + 2]!)
        maxY = Math.max(maxY, boxes[o + 3]!)
      }
      const o = 4 * (start[L]! + p)
      boxes[o] = minX
      boxes[o + 1] = minY
      boxes[o + 2] = maxX
      boxes[o + 3] = maxY
    }
  }
}

function copyBox(from: Float64Array, i: number, to: Float64Array, j: number): void {
  to[4 * j] = from[4 * i]!
  to[4 * j + 1] = from[4 * i + 1]!
  to[4 * j + 2] = from[4 * i + 2]!
  to[4 * j + 3] = from[4 * i + 3]!
}

/**
 * Full build: sorts every item, yielding every BUILD_STEP items. `cache` holds 4 bbox values per id and must not
 * change until the end. Rare (loads, big edits): its scratch is not kept.
 */
function* coldBuild(ids: Float64Array, cache: Float64Array, spare: Tree | null): Generator<void, Tree> {
  const n = ids.length
  // Doubled bbox centres and their keys.
  const cx = new Float64Array(n)
  const cy = new Float64Array(n)
  const keys = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    if (i % BUILD_STEP === BUILD_STEP - 1) yield
    const o = 4 * ids[i]!
    cx[i] = cache[o]! + cache[o + 2]!
    cy[i] = cache[o + 1]! + cache[o + 3]!
  }
  // The margin lets later edits near the edges merge instead of forcing another cold build.
  const frame = hilbertFrame(cx, cy, n, 0.25)
  for (let i = 0; i < n; i++) {
    if (i % BUILD_STEP === BUILD_STEP - 1) yield
    keys[i] = hilbertKey(frame, cx[i]!, cy[i]!)
  }
  yield
  const order = radixOrder(keys, n)
  yield
  const t = allocTree(n, frame, spare)
  for (let i = 0; i < n; i++) {
    if (i % BUILD_STEP === BUILD_STEP - 1) yield
    const j = order[i]!
    const id = ids[j]!
    t.ids[i] = id
    t.keys[i] = keys[j]!
    copyBox(cache, id, t.boxes, i)
  }
  yield
  packLevels(t)
  return t
}

/**
 * Merges the sorted survivors of `old` with the sorted extras, reading the old leaves in order. Null when an
 * extra falls outside the old frame: its key would not be comparable.
 */
function mergeBuild(
  old: Tree, spare: Tree | null, extra: readonly number[], isStale: (id: number) => boolean, cache: Float64Array, n: number,
): Tree | null {
  const m = extra.length
  const ek = new Uint32Array(m)
  for (let i = 0; i < m; i++) {
    const o = 4 * extra[i]!
    const k = hilbertKey(old.frame, cache[o]! + cache[o + 2]!, cache[o + 1]! + cache[o + 3]!)
    if (k < 0) return null
    ek[i] = k
  }
  const eo = radixOrder(ek, m)
  const t = allocTree(n, old.frame, spare)
  const oldN = old.n
  let i = 0
  let j = 0
  let w = 0
  for (;;) {
    while (i < oldN && isStale(old.ids[i]!)) i++
    const takeOld = i < oldN && (j >= m || old.keys[i]! <= ek[eo[j]!]!)
    if (!takeOld && j >= m) break
    if (w === n) return null // the counts disagree: fall back to a cold build
    if (takeOld) {
      t.ids[w] = old.ids[i]!
      t.keys[w] = old.keys[i]!
      copyBox(old.boxes, i, t.boxes, w)
      i++
    } else {
      const id = extra[eo[j]!]!
      t.ids[w] = id
      t.keys[w] = ek[eo[j]!]!
      copyBox(cache, id, t.boxes, w)
      j++
    }
    w++
  }
  if (w !== n) return null
  packLevels(t)
  return t
}

function searchTree(t: Tree, b: BBox, isStale: (id: number) => boolean, out: number[]): void {
  const { boxes, ids, start, size } = t
  const hit = (o: number): boolean => boxes[o]! <= b.maxX && b.minX <= boxes[o + 2]! && boxes[o + 1]! <= b.maxY && b.minY <= boxes[o + 3]!
  const emit = (i: number): void => {
    if (!isStale(ids[i]!)) out.push(ids[i]!)
  }
  const top = start.length - 1
  if (!hit(4 * start[top]!)) return
  if (top === 0) return emit(0)
  // Pairs (level, node) of nodes already known to intersect b.
  const stack = [top, 0]
  while (stack.length > 0) {
    const j = stack.pop()!
    const L = stack.pop()!
    const last = Math.min((j + 1) * NODE, size[L - 1]!)
    const below = start[L - 1]!
    for (let c = j * NODE; c < last; c++) {
      if (!hit(4 * (below + c))) continue
      if (L === 1) emit(c)
      else stack.push(L - 1, c)
    }
  }
}

/**
 * Packed Hilbert R-tree rebuilt on demand. Each id's bbox is cached in a dense array (ids are small increasing
 * integers), so a rebuild never walks the document. Edits since the build form a dirty list scanned by every
 * query: `extra` holds the added and changed ids, stale ids mask their entries in the tree. A rebuild after edits
 * merges the sorted extras into the old leaf order instead of sorting everything again. A big tree that must be
 * sorted again goes in steps (build); until it is whole, queries scan the cache.
 */
export function createSpatialIndex(doc: Document, opts: SpatialIndexOptions = {}): SpatialIndex {
  let cache = new Float64Array(4 * 1024)
  let flags = new Uint8Array(1024) // LIVE | STALE per id
  const LIVE = 1
  const STALE = 2
  let liveCount = 0
  let tree: Tree | null = null
  let spare: Tree | null = null // the previous tree, whose arrays the next rebuild writes into
  const staleIds: number[] = []
  const extra = new Set<number>()
  let rebuilds = 0
  let coldBuilds = 0
  let disposed = false
  /** The cold build under way (build), dropped by any change. */
  let pending: Generator<void, Tree> | null = null
  /** The document changed since the last build() call. */
  let changed = false
  const big = (): boolean => liveCount >= (opts.sliceFrom ?? SLICE_FROM)

  const isStale = (id: number): boolean => (flags[id]! & STALE) !== 0

  /** Caches e's bbox; false, leaving e out, when e has no geometry (an opaque entity). */
  function put(e: Entity): boolean {
    const b = typeOf(e).bbox(e)
    if (bboxEmpty(b)) return false
    if (e.id >= flags.length) {
      const grown = Math.max(Math.ceil(1.5 * flags.length), e.id + 1)
      const c = new Float64Array(4 * grown)
      c.set(cache)
      cache = c
      const f = new Uint8Array(grown)
      f.set(flags)
      flags = f
    }
    const o = 4 * e.id
    cache[o] = b.minX
    cache[o + 1] = b.minY
    cache[o + 2] = b.maxX
    cache[o + 3] = b.maxY
    if (!(flags[e.id]! & LIVE)) liveCount++
    flags[e.id]! |= LIVE
    return true
  }

  function markStale(id: number): void {
    if (isStale(id)) return
    flags[id]! |= STALE
    staleIds.push(id)
  }

  for (const e of doc.entities()) put(e)
  let built = liveCount === 0

  const limit = (): number => opts.maxDirty ?? Math.max(4096, (tree?.n ?? 0) / 64)

  /** Drops what tracks edits since the build: the tree is to be sorted again. */
  function unbuild(): void {
    built = false
    for (const id of staleIds) flags[id]! &= ~STALE
    staleIds.length = 0
    extra.clear()
  }

  const off = doc.onChange((c) => {
    changed = true
    pending = null // it read the cache as it was
    // A change that rivals the tree (a load, a mass erase) goes straight to a cold build: tracking it entity by
    // entity would cost more than the build, and a merge would gain nothing over a full sort.
    const dirty = staleIds.length + extra.size + c.added.length + c.changed.length + c.removed.length
    const bulk = c.bulk === true || !built || dirty > Math.max(limit(), (tree?.n ?? 0) / 4)
    if (bulk) unbuild()
    for (const e of c.removed) {
      if (!(flags[e.id]! & LIVE)) continue // never indexed
      liveCount--
      flags[e.id]! &= ~LIVE
      if (bulk) continue
      markStale(e.id)
      extra.delete(e.id)
    }
    for (const [, e] of c.changed) {
      if (!put(e) || bulk) continue
      markStale(e.id)
      extra.add(e.id)
    }
    for (const e of c.added) if (put(e) && !bulk) extra.add(e.id)
  })

  /** A cold build of every live id. The old tree is about to go: its arrays can take the new one. */
  function startCold(): Generator<void, Tree> {
    const ids = new Float64Array(liveCount)
    let k = 0
    for (let id = 1; id < flags.length; id++) if (flags[id]! & LIVE) ids[k++] = id
    return coldBuild(ids, cache, spare ?? tree)
  }

  /**
   * Brings the tree up to date now: a merge of the edits, or a cold build of a small tree. A big tree the merge
   * cannot take is left to build() (built stays false).
   */
  function rebuild(): void {
    let next: Tree | null = null
    if (liveCount > 0) {
      next = tree && built ? mergeBuild(tree, spare, [...extra], isStale, cache, liveCount) : null
      if (!next) {
        if (big()) return unbuild()
        next = drain(startCold())
        coldBuilds++
      }
    }
    install(next)
  }

  function install(next: Tree | null): void {
    // The outgoing tree becomes the spare unless its arrays now hold the new tree; a spare whose arrays were
    // just taken is dropped, or the next merge would write into the leaves it reads.
    const prev = tree
    tree = next
    if (prev && prev.boxes !== next?.boxes) spare = prev
    else if (spare && spare.boxes === next?.boxes) spare = null
    for (const id of staleIds) flags[id]! &= ~STALE
    staleIds.length = 0
    extra.clear()
    built = true
    rebuilds++
  }

  /** Every live id whose cached bbox meets b: what a query answers while a big tree is not built. */
  function scan(b: BBox, out: number[]): void {
    for (let id = 1; id < flags.length; id++) {
      if (!(flags[id]! & LIVE)) continue
      const o = 4 * id
      if (cache[o]! <= b.maxX && b.minX <= cache[o + 2]! && cache[o + 1]! <= b.maxY && b.minY <= cache[o + 3]!) out.push(id)
    }
  }

  return {
    query(b) {
      if (disposed) throw new Error('the spatial index is disposed')
      if (built ? staleIds.length + extra.size > limit() : !big()) rebuild()
      const out: number[] = []
      if (!built) {
        scan(b, out)
        return out
      }
      if (tree) searchTree(tree, b, isStale, out)
      for (const id of extra) {
        const o = 4 * id
        if (cache[o]! <= b.maxX && b.minX <= cache[o + 2]! && cache[o + 1]! <= b.maxY && b.minY <= cache[o + 3]!) out.push(id)
      }
      return out
    },
    get building() {
      return !built && big()
    },
    build(more) {
      if (disposed) throw new Error('the spatial index is disposed')
      const quiet = !changed
      changed = false
      if (built) return
      if (!big()) return rebuild()
      if (!pending) {
        if (!quiet) return
        pending = startCold()
      }
      do {
        const r = pending.next()
        if (r.done) {
          pending = null
          coldBuilds++
          install(r.value)
          return
        }
      } while (more())
    },
    get rebuilds() {
      return rebuilds
    },
    get coldBuilds() {
      return coldBuilds
    },
    dispose() {
      disposed = true
      off()
    },
  }
}
