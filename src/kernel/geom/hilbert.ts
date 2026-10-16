// The curve: 0 at (0, 0), then up, right and down, ending at (65535, 0). At each level the cell's quadrant
// gives two digits, then the lower bits are reflected and/or transposed into that quadrant's frame. The frame is
// one of four transforms of the original axes: 0 identity, 1 transpose, 2 anti-transpose, 3 rotation by 180°.

const TRANSPOSE = [1, 0, 3, 2] // transpose ∘ frame
const ANTI = [2, 3, 0, 1] // anti-transpose ∘ frame

// TABLE[frame << 8 | xNibble << 4 | yNibble] = next frame << 8 | the 8 digits of those 4 levels.
const TABLE = new Uint16Array(4 << 8)
for (let frame = 0; frame < 4; frame++) {
  for (let xn = 0; xn < 16; xn++) {
    for (let yn = 0; yn < 16; yn++) {
      let f = frame
      let digits = 0
      for (let bit = 3; bit >= 0; bit--) {
        const bx = (xn >> bit) & 1
        const by = (yn >> bit) & 1
        const rx = f === 0 ? bx : f === 1 ? by : f === 2 ? 1 - by : 1 - bx
        const ry = f === 0 ? by : f === 1 ? bx : f === 2 ? 1 - bx : 1 - by
        digits = (digits << 2) | ((3 * rx) ^ ry)
        if (ry === 0) f = rx === 1 ? ANTI[f]! : TRANSPOSE[f]!
      }
      TABLE[(frame << 8) | (xn << 4) | yn] = (f << 8) | digits
    }
  }
}

/** Position along the Hilbert curve of the cell (x, y), both integers in 0..65535. */
export function hilbert16(x: number, y: number): number {
  let d = 0
  let frame = 0
  for (let shift = 12; shift >= 0; shift -= 4) {
    const e = TABLE[(frame << 8) | (((x >> shift) & 15) << 4) | ((y >> shift) & 15)]!
    d = ((d << 8) | (e & 255)) >>> 0
    frame = e >> 8
  }
  return d
}

// Working arrays shared by every sort; they only grow. Callers never see them.
let k1 = new Uint32Array(0)
let k2 = new Uint32Array(0)
let i2 = new Uint32Array(0)
const count = new Uint32Array(2048)

/** Stable permutation that sorts keys[0, n) ascending: LSD radix, 11-bit digits. */
export function radixOrder(keys: Uint32Array, n = keys.length): Uint32Array {
  if (k1.length < n) {
    k1 = new Uint32Array(n)
    k2 = new Uint32Array(n)
    i2 = new Uint32Array(n)
  }
  let idx = new Uint32Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  let ka = k1
  let kb = k2
  let ia = idx
  let ib = i2
  ka.set(keys.subarray(0, n))
  for (let shift = 0; shift < 32; shift += 11) {
    count.fill(0)
    for (let i = 0; i < n; i++) count[(ka[i]! >>> shift) & 2047]!++
    if (count.includes(n)) continue // every key has the same digit: the pass changes nothing
    let sum = 0
    for (let b = 0; b < 2048; b++) {
      const c = count[b]!
      count[b] = sum
      sum += c
    }
    for (let i = 0; i < n; i++) {
      const p = count[(ka[i]! >>> shift) & 2047]!++
      kb[p] = ka[i]!
      ib[p] = ia[i]!
    }
    ;[ka, kb] = [kb, ka]
    ;[ia, ib] = [ib, ia]
  }
  if (ia !== idx) {
    idx.set(ia.subarray(0, n))
  }
  return idx
}

/** Maps points to the 16-bit Hilbert grid: q = (v − x0) · sx. */
export interface HilbertFrame { x0: number; y0: number; sx: number; sy: number }

/** The frame that spans the points (xs[i], ys[i]), i < n, widened by `margin` times the span on every side. */
export function hilbertFrame(xs: Float64Array, ys: Float64Array, n = xs.length, margin = 0): HilbertFrame {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const x = xs[i]!
    const y = ys[i]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const w = (maxX - minX) * (1 + 2 * margin)
  const h = (maxY - minY) * (1 + 2 * margin)
  return {
    x0: minX - (maxX - minX) * margin,
    y0: minY - (maxY - minY) * margin,
    sx: w > 0 ? 65535 / w : 0,
    sy: h > 0 ? 65535 / h : 0,
  }
}

/** Hilbert key of (x, y) in the frame; −1 when the point lies outside it. */
export function hilbertKey(f: HilbertFrame, x: number, y: number): number {
  const qx = (x - f.x0) * f.sx
  const qy = (y - f.y0) * f.sy
  // The frame's own corners can land a hair past 65535 through rounding.
  if (!(qx >= 0 && qx < 65536 && qy >= 0 && qy < 65536)) return -1
  return hilbert16(qx | 0, qy | 0)
}

let keyScratch = new Uint32Array(0)

/** Permutation visiting the points (xs[i], ys[i]), i < n, in Hilbert order over their own extents. */
export function hilbertOrder(xs: Float64Array, ys: Float64Array, n = xs.length): Uint32Array {
  const f = hilbertFrame(xs, ys, n)
  if (keyScratch.length < n) keyScratch = new Uint32Array(n)
  const keys = keyScratch
  for (let i = 0; i < n; i++) keys[i] = hilbert16(((xs[i]! - f.x0) * f.sx) | 0, ((ys[i]! - f.y0) * f.sy) | 0)
  return radixOrder(keys, n)
}
