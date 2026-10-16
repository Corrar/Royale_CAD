import type { Draft } from '../document'
import type { Attrib, Block, BlockEntity, Text } from '../entity/types'

const KIND = { line: 0, circle: 1, arc: 2, point: 3, polyline: 4, opaque: 5, ellipse: 6, spline: 7, insert: 8, text: 9, mtext: 10 } as const

/**
 * Drafts as a few typed arrays, so a worker can hand a million of them over without the structured clone of a
 * million objects (seconds on the receiving thread): the arrays move, and the drafts are rebuilt slice by slice.
 */
export interface DraftPack {
  /** The drafts asked for; the arrays may hold more after them: the entities of the blocks. */
  readonly n: number
  readonly kinds: Uint8Array
  readonly layers: Uint32Array
  /** The color + 1; 0 is ByLayer (ByBlock is color 0). */
  readonly colors: Uint32Array
  /**
   * The numbers, draft after draft: line x0 y0 x1 y1 · circle cx cy r · arc cx cy r a0 a1 · point x y · polyline
   * closed, vertex count, the coordinates, then 1 and a bulge per vertex, or 0, then 1 and a start and end width per
   * vertex, or 0, then startWidth endWidth (0 when absent) · opaque its index in names/raws ·
   * ellipse cx cy mx my ratio t0 t1 · spline degree, closed, knot count, the knots, control point count, the
   * coordinates, then 1 and a weight per point, or 0 · insert its block's index in blocks, x y sx sy rotation cols
   * rows dx dy, its attribute count, then for each its tag's index in texts, layer, color + 1 and the numbers of a
   * text, hidden adding 4 to its flags · text its value's index in texts, x y x2 y2 height rotation widthFactor
   * oblique halign valign, then backward + 2·upsideDown · mtext its value's index, x y height width attachment
   * rotation spacing.
   */
  readonly nums: Float64Array
  /** Draft k's numbers start at nums[at[k]]. */
  readonly at: Uint32Array
  readonly names: string[]
  readonly raws: string[]
  /** The strings of texts. */
  readonly texts: string[]
  /** The blocks inserts show: entities [from, to) of the pack are a block's. */
  readonly blocks: { name: string; x: number; y: number; from: number; to: number }[]
}

export function packDrafts(drafts: readonly Draft[]): DraftPack {
  // The drafts, then the entities of every block an insert shows, block after block, as they are met.
  const all: (Draft | BlockEntity)[] = [...drafts]
  const blockIndex = new Map<Block, number>()
  const blocks: DraftPack['blocks'] = []
  const blockObjects: Block[] = []
  const indexOf = (b: Block): number => {
    let i = blockIndex.get(b)
    if (i === undefined) {
      blockIndex.set(b, (i = blocks.length))
      blocks.push({ name: b.name, x: b.x, y: b.y, from: 0, to: 0 })
      blockObjects.push(b)
    }
    return i
  }
  const n = drafts.length
  let kinds = new Uint8Array(n)
  let layers = new Uint32Array(n)
  let colors = new Uint32Array(n)
  let at = new Uint32Array(n + 1)
  let nums = new Float64Array(Math.max(16, n * 5))
  let len = 0
  const names: string[] = []
  const raws: string[] = []
  const texts: string[] = []
  const need = (k: number): void => {
    if (len + k <= nums.length) return
    const grown = new Float64Array(Math.max(2 * nums.length, len + k))
    grown.set(nums)
    nums = grown
  }
  const put = (...v: number[]): void => {
    need(v.length)
    for (const x of v) nums[len++] = x
  }
  const room = (k: number): void => {
    if (k < kinds.length) return
    const grow = <T extends Uint8Array | Uint32Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(2 * a.length + 16)
      b.set(a)
      return b
    }
    kinds = grow(kinds)
    layers = grow(layers)
    colors = grow(colors)
    const grownAt = new Uint32Array(kinds.length + 1)
    grownAt.set(at)
    at = grownAt
  }
  const putText = (t: Omit<Text, 'id' | 'layer'>, more: number): void => {
    put(texts.length, t.x, t.y, t.x2, t.y2, t.height, t.rotation, t.widthFactor, t.oblique, t.halign, t.valign, (t.backward ? 1 : 0) + (t.upsideDown ? 2 : 0) + more)
    texts.push(t.value)
  }
  const encode = (k: number): void => {
    room(k)
    const d = all[k]!
    kinds[k] = KIND[d.type]
    layers[k] = d.layer
    colors[k] = d.color === undefined ? 0 : d.color + 1
    at[k] = len
    switch (d.type) {
      case 'line':
        put(d.x0, d.y0, d.x1, d.y1)
        break
      case 'circle':
        put(d.cx, d.cy, d.r)
        break
      case 'arc':
        put(d.cx, d.cy, d.r, d.a0, d.a1)
        break
      case 'point':
        put(d.x, d.y)
        break
      case 'polyline': {
        const m = d.pts.length >> 1
        need(6 + 5 * m)
        nums[len++] = d.closed ? 1 : 0
        nums[len++] = m
        nums.set(d.pts, len)
        len += d.pts.length
        nums[len++] = d.bulges ? 1 : 0
        if (d.bulges) {
          nums.set(d.bulges, len)
          len += m
        }
        nums[len++] = d.widths ? 1 : 0
        if (d.widths) {
          nums.set(d.widths, len)
          len += 2 * m
        }
        nums[len++] = d.startWidth ?? 0
        nums[len++] = d.endWidth ?? 0
        break
      }
      case 'opaque':
        put(names.length)
        names.push(d.name)
        raws.push(d.raw)
        break
      case 'ellipse':
        put(d.cx, d.cy, d.mx, d.my, d.ratio, d.t0, d.t1)
        break
      case 'insert':
        put(indexOf(d.block), d.x, d.y, d.sx, d.sy, d.rotation, d.cols, d.rows, d.dx, d.dy, d.attribs?.length ?? 0)
        for (const a of d.attribs ?? []) {
          put(texts.length, a.layer, a.color === undefined ? 0 : a.color + 1)
          texts.push(a.tag)
          putText(a, a.hidden ? 4 : 0)
        }
        break
      case 'text':
        putText(d, 0)
        break
      case 'mtext':
        put(texts.length, d.x, d.y, d.height, d.width, d.attachment, d.rotation, d.spacing)
        texts.push(d.value)
        break
      case 'spline': {
        const m = d.ctrl.length >> 1
        need(5 + d.knots.length + 3 * m)
        nums[len++] = d.degree
        nums[len++] = d.closed ? 1 : 0
        nums[len++] = d.knots.length
        nums.set(d.knots, len)
        len += d.knots.length
        nums[len++] = m
        nums.set(d.ctrl, len)
        len += d.ctrl.length
        nums[len++] = d.weights ? 1 : 0
        if (d.weights) {
          nums.set(d.weights, len)
          len += m
        }
        break
      }
    }
  }
  // Everything listed so far, then the next block's entities, until no block is left out.
  let k = 0
  for (let next = 0; ; next++) {
    for (; k < all.length; k++) encode(k)
    if (next === blocks.length) break
    blocks[next]!.from = all.length
    all.push(...blockObjects[next]!.entities)
    blocks[next]!.to = all.length
  }
  const m = all.length
  room(m)
  at[m] = len
  return { n, kinds: kinds.slice(0, m), layers: layers.slice(0, m), colors: colors.slice(0, m), nums: nums.slice(0, len), at: at.slice(0, m + 1), names, raws, texts, blocks }
}

/** The buffers to transfer with a pack. */
export const packBuffers = (p: DraftPack): ArrayBuffer[] => [p.kinds.buffer, p.layers.buffer, p.colors.buffer, p.nums.buffer, p.at.buffer] as ArrayBuffer[]

/** The blocks of a pack, made once each: inserts of one block share it. */
const made = new WeakMap<DraftPack, Block[]>()

function blockOf(p: DraftPack, i: number): Block {
  let list = made.get(p)
  if (!list) made.set(p, (list = []))
  let b = list[i]
  if (!b) {
    const { name, x, y, from, to } = p.blocks[i]!
    list[i] = b = { name, x, y, entities: unpackDrafts(p, from, to) as unknown as BlockEntity[] }
  }
  return b
}

/** The numbers a text takes. */
const TEXT_NUMS = 12

/** The text whose numbers start at nums[o]. */
function textAt(p: DraftPack, o: number, layer: number): Draft<Text> {
  const v = p.nums
  const flags = v[o + 11]!
  return {
    type: 'text', layer, value: p.texts[v[o]!]!, x: v[o + 1]!, y: v[o + 2]!, x2: v[o + 3]!, y2: v[o + 4]!, height: v[o + 5]!,
    rotation: v[o + 6]!, widthFactor: v[o + 7]!, oblique: v[o + 8]!, halign: v[o + 9]!, valign: v[o + 10]!,
    backward: (flags & 1) !== 0, upsideDown: (flags & 2) !== 0,
  }
}

/** Drafts [from, to) of a pack. */
export function unpackDrafts(p: DraftPack, from: number, to: number): Draft[] {
  const out: Draft[] = new Array(Math.max(0, to - from))
  const v = p.nums
  for (let k = from; k < to; k++) {
    const o = p.at[k]!
    const layer = p.layers[k]!
    let d: Draft
    switch (p.kinds[k]) {
      case KIND.line:
        d = { type: 'line', layer, x0: v[o]!, y0: v[o + 1]!, x1: v[o + 2]!, y1: v[o + 3]! }
        break
      case KIND.circle:
        d = { type: 'circle', layer, cx: v[o]!, cy: v[o + 1]!, r: v[o + 2]! }
        break
      case KIND.arc:
        d = { type: 'arc', layer, cx: v[o]!, cy: v[o + 1]!, r: v[o + 2]!, a0: v[o + 3]!, a1: v[o + 4]! }
        break
      case KIND.point:
        d = { type: 'point', layer, x: v[o]!, y: v[o + 1]! }
        break
      case KIND.polyline: {
        const m = v[o + 1]!
        const pts = v.slice(o + 2, o + 2 + 2 * m)
        const b = o + 2 + 2 * m
        const w = v[b] === 1 ? b + 1 + m : b + 1
        const s = v[w] === 1 ? w + 1 + 2 * m : w + 1
        d = {
          type: 'polyline', layer, pts, bulges: v[b] === 1 ? v.slice(b + 1, b + 1 + m) : null, closed: v[o] === 1,
          ...(v[w] === 1 && { widths: v.slice(w + 1, w + 1 + 2 * m) }),
          ...(v[s] !== 0 && { startWidth: v[s]! }),
          ...(v[s + 1] !== 0 && { endWidth: v[s + 1]! }),
        }
        break
      }
      case KIND.ellipse:
        d = { type: 'ellipse', layer, cx: v[o]!, cy: v[o + 1]!, mx: v[o + 2]!, my: v[o + 3]!, ratio: v[o + 4]!, t0: v[o + 5]!, t1: v[o + 6]! }
        break
      case KIND.spline: {
        const nk = v[o + 2]!
        const knots = v.slice(o + 3, o + 3 + nk)
        const m = v[o + 3 + nk]!
        const c = o + 4 + nk
        const ctrl = v.slice(c, c + 2 * m)
        const w = c + 2 * m
        d = { type: 'spline', layer, degree: v[o]!, closed: v[o + 1] === 1, knots, ctrl, weights: v[w] === 1 ? v.slice(w + 1, w + 1 + m) : null }
        break
      }
      case KIND.insert: {
        d = {
          type: 'insert', layer, block: blockOf(p, v[o]!), x: v[o + 1]!, y: v[o + 2]!, sx: v[o + 3]!, sy: v[o + 4]!,
          rotation: v[o + 5]!, cols: v[o + 6]!, rows: v[o + 7]!, dx: v[o + 8]!, dy: v[o + 9]!,
        }
        const count = v[o + 10]!
        if (count > 0) {
          const attribs: Attrib[] = []
          for (let i = 0, a = o + 11; i < count; i++, a += 3 + TEXT_NUMS) {
            const c = v[a + 2]!
            attribs.push({ ...textAt(p, a + 3, v[a + 1]!), ...(c !== 0 && { color: c - 1 }), tag: p.texts[v[a]!]!, hidden: (v[a + 3 + 11]! & 4) !== 0 })
          }
          d = { ...d, attribs }
        }
        break
      }
      case KIND.text:
        d = textAt(p, o, layer)
        break
      case KIND.mtext:
        d = {
          type: 'mtext', layer, value: p.texts[v[o]!]!, x: v[o + 1]!, y: v[o + 2]!, height: v[o + 3]!, width: v[o + 4]!,
          attachment: v[o + 5]!, rotation: v[o + 6]!, spacing: v[o + 7]!,
        }
        break
      default: {
        const i = v[o]!
        d = { type: 'opaque', layer, name: p.names[i]!, raw: p.raws[i]! }
      }
    }
    const c = p.colors[k]!
    if (c !== 0) (d as { color?: number }).color = c - 1
    out[k - from] = d
  }
  return out
}
