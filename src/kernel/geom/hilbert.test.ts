import { describe, expect, it } from 'vitest'
import { hilbert16, hilbertFrame, hilbertKey, hilbertOrder, radixOrder } from './hilbert'

// Textbook recursion, the specification of hilbert16: take the quadrant's rank, then reflect and/or transpose
// the lower bits into that quadrant's frame.
function reference(x: number, y: number): number {
  let d = 0
  for (let s = 1 << 15; s > 0; s >>>= 1) {
    const rx = (x & s) !== 0 ? 1 : 0
    const ry = (y & s) !== 0 ? 1 : 0
    d += s * s * ((3 * rx) ^ ry)
    if (ry === 0) {
      if (rx === 1) {
        x ^= s - 1
        y ^= s - 1
      }
      ;[x, y] = [y, x]
    }
  }
  return d
}

describe('hilbert16', () => {
  it('matches the textbook recursion', () => {
    let s = 5
    const rand = (): number => (s = (s * 16807) % 2147483647) % 65536
    for (let i = 0; i < 20000; i++) {
      const x = rand()
      const y = rand()
      expect(hilbert16(x, y)).toBe(reference(x, y))
    }
    for (const [x, y] of [[0, 0], [65535, 65535], [0, 65535], [65535, 0], [32768, 32767]] as const) {
      expect(hilbert16(x, y)).toBe(reference(x, y))
    }
  })

  it('visits a 2^k grid once, each step moving to a 4-neighbour', () => {
    // On a 16 x 16 grid scaled to the 16-bit space, consecutive cells along the curve are adjacent.
    const k = 4
    const side = 1 << k
    const shift = 16 - k
    const at = new Map<number, [number, number]>()
    for (let x = 0; x < side; x++) {
      for (let y = 0; y < side; y++) {
        // The low bits pick a point inside the cell; the cell's index is the high part.
        const d = Math.floor(hilbert16((x << shift) | 5, (y << shift) | 9) / 2 ** (2 * shift))
        expect(at.has(d)).toBe(false)
        at.set(d, [x, y])
      }
    }
    expect([...at.keys()].sort((a, b) => a - b)).toEqual([...Array(side * side).keys()])
    for (let d = 1; d < side * side; d++) {
      const [x0, y0] = at.get(d - 1)!
      const [x1, y1] = at.get(d)!
      expect(Math.abs(x1 - x0) + Math.abs(y1 - y0)).toBe(1)
    }
  })

  it('spans 0 .. 2^32 − 1', () => {
    expect(hilbert16(0, 0)).toBe(0)
    let max = 0
    for (const x of [0, 65535]) for (const y of [0, 65535]) max = Math.max(max, hilbert16(x, y))
    expect(max).toBe(2 ** 32 - 1)
  })
})

describe('radixOrder', () => {
  it('sorts only the first n keys when asked', () => {
    expect(Array.from(radixOrder(new Uint32Array([3, 1, 2, 0]), 3))).toEqual([1, 2, 0])
  })

  it('is a stable ascending permutation', () => {
    let s = 9
    const rand = (): number => (s = (s * 16807) % 2147483647)
    for (const n of [0, 1, 7, 5000]) {
      const keys = new Uint32Array(n)
      for (let i = 0; i < n; i++) keys[i] = i % 3 === 0 ? 42 : (rand() * 2654435761) >>> 0
      const got = Array.from(radixOrder(keys))
      const want = [...keys.keys()].sort((a, b) => keys[a]! - keys[b]! || a - b)
      expect(got).toEqual(want)
    }
  })
})

describe('hilbertOrder', () => {
  it('orders points along the curve over their own extents', () => {
    const xs = new Float64Array([10, 0, 10, 0])
    const ys = new Float64Array([0, 0, 10, 10])
    // The curve starts at the lower-left corner and ends at the lower-right one.
    expect(Array.from(hilbertOrder(xs, ys))).toEqual([1, 3, 2, 0])
  })

  it('handles degenerate extents', () => {
    expect(Array.from(hilbertOrder(new Float64Array([5, 5]), new Float64Array([1, 1])))).toEqual([0, 1])
    expect(Array.from(hilbertOrder(new Float64Array(0), new Float64Array(0)))).toEqual([])
  })
})

describe('hilbertFrame and hilbertKey', () => {
  it('maps the extents, widened by the margin, onto the grid and rejects points outside', () => {
    const f = hilbertFrame(new Float64Array([0, 10]), new Float64Array([0, 10]), 2, 0.5)
    expect([f.x0, f.y0]).toEqual([-5, -5])
    expect(hilbertKey(f, -5, -5)).toBe(0)
    expect(hilbertKey(f, 15, -5)).toBe(hilbert16(65535, 0))
    expect(hilbertKey(f, 5, 5)).toBe(hilbert16(32767, 32767))
    expect(hilbertKey(f, -5.1, 0)).toBe(-1)
    expect(hilbertKey(f, 0, 15.1)).toBe(-1)
    expect(hilbertKey(f, NaN, 0)).toBe(-1)
  })
})
