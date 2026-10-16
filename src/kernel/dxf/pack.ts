import type { Draft } from '../document'

const KIND = { line: 0, circle: 1, arc: 2, point: 3, polyline: 4, opaque: 5, ellipse: 6, spline: 7 } as const

/**
 * Drafts as a few typed arrays, so a worker can hand a million of them over without the structured clone of a
 * million objects (seconds on the receiving thread): the arrays move, and the drafts are rebuilt slice by slice.
 */
export interface DraftPack {
  readonly n: number
  readonly kinds: Uint8Array
  readonly layers: Uint32Array
  /** 0 is ByLayer. */
  readonly colors: Uint32Array
  /**
   * The numbers, draft after draft: line x0 y0 x1 y1 · circle cx cy r · arc cx cy r a0 a1 · point x y · polyline
   * closed, vertex count, the coordinates, then 1 and a bulge per vertex, or 0 · opaque its index in names/raws ·
   * ellipse cx cy mx my ratio t0 t1 · spline degree, closed, knot count, the knots, control point count, the
   * coordinates, then 1 and a weight per point, or 0.
   */
  readonly nums: Float64Array
  /** Draft k's numbers start at nums[at[k]]. */
  readonly at: Uint32Array
  readonly names: string[]
  readonly raws: string[]
}

export function packDrafts(drafts: readonly Draft[]): DraftPack {
  const n = drafts.length
  const kinds = new Uint8Array(n)
  const layers = new Uint32Array(n)
  const colors = new Uint32Array(n)
  const at = new Uint32Array(n + 1)
  let nums = new Float64Array(Math.max(16, n * 5))
  let len = 0
  const names: string[] = []
  const raws: string[] = []
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
  for (let k = 0; k < n; k++) {
    const d = drafts[k]!
    kinds[k] = KIND[d.type]
    layers[k] = d.layer
    colors[k] = d.color ?? 0
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
        need(3 + 3 * m)
        nums[len++] = d.closed ? 1 : 0
        nums[len++] = m
        nums.set(d.pts, len)
        len += d.pts.length
        nums[len++] = d.bulges ? 1 : 0
        if (d.bulges) {
          nums.set(d.bulges, len)
          len += m
        }
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
  at[n] = len
  return { n, kinds, layers, colors, nums: nums.slice(0, len), at, names, raws }
}

/** The buffers to transfer with a pack. */
export const packBuffers = (p: DraftPack): ArrayBuffer[] => [p.kinds.buffer, p.layers.buffer, p.colors.buffer, p.nums.buffer, p.at.buffer] as ArrayBuffer[]

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
        d = { type: 'polyline', layer, pts, bulges: v[b] === 1 ? v.slice(b + 1, b + 1 + m) : null, closed: v[o] === 1 }
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
      default: {
        const i = v[o]!
        d = { type: 'opaque', layer, name: p.names[i]!, raw: p.raws[i]! }
      }
    }
    const c = p.colors[k]!
    if (c !== 0) (d as { color?: number }).color = c
    out[k - from] = d
  }
  return out
}
