import { describe, expect, it } from 'vitest'
import { arcSpansInBox, clipSegment } from './clip'
import { TAU, normAngle } from './tol'

const BOX = { minX: 0, minY: 0, maxX: 10, maxY: 5 }
const inside = (x: number, y: number, eps = 1e-9): boolean =>
  x >= BOX.minX - eps && x <= BOX.maxX + eps && y >= BOX.minY - eps && y <= BOX.maxY + eps

describe('clipSegment', () => {
  it('keeps a segment that is inside', () => {
    expect(clipSegment(BOX, 1, 1, 9, 4)).toEqual([1, 1, 9, 4])
  })

  it('cuts a segment that crosses the box at the edges, keeping its direction', () => {
    expect(clipSegment(BOX, -10, 2, 20, 2)).toEqual([0, 2, 10, 2])
    expect(clipSegment(BOX, 20, 2, -10, 2)).toEqual([10, 2, 0, 2])
    const c = clipSegment(BOX, -5, -5, 15, 15)!
    expect(c).toEqual([0, 0, 5, 5])
  })

  it('is null outside, including parallel lines past an edge', () => {
    expect(clipSegment(BOX, -5, 6, 15, 6)).toBeNull()
    expect(clipSegment(BOX, 11, -1, 11, 9)).toBeNull()
    expect(clipSegment(BOX, -5, 9, 5, 20)).toBeNull()
  })

  it('touching an edge or a corner counts', () => {
    expect(clipSegment(BOX, -1, 5, 3, 5)).toEqual([0, 5, 3, 5])
    expect(clipSegment(BOX, -1, 1, 1, -1)).toEqual([0, 0, 0, 0])
  })

  it('a point is kept only inside', () => {
    expect(clipSegment(BOX, 3, 3, 3, 3)).toEqual([3, 3, 3, 3])
    expect(clipSegment(BOX, 30, 3, 30, 3)).toBeNull()
  })
})

/** Walks the arc finely and checks that the spans hold exactly the inside samples. */
function checkSpans(cx: number, cy: number, r: number, a0: number, sweep: number): number[] {
  const spans = arcSpansInBox(BOX, cx, cy, r, a0, sweep)
  const start = sweep >= 0 ? a0 : a0 + sweep
  const len = Math.min(Math.abs(sweep), TAU)
  const inSpan = (a: number): boolean => {
    for (let k = 0; k < spans.length; k += 2) if (normAngle(a - spans[k]!) <= spans[k + 1]!) return true
    return false
  }
  for (let k = 0; k < spans.length; k += 2) {
    expect(spans[k + 1]).toBeGreaterThan(0)
    for (const t of [0, 1]) {
      const a = spans[k]! + t * spans[k + 1]!
      expect(inside(cx + r * Math.cos(a), cy + r * Math.sin(a)), 'span ends lie in the box').toBe(true)
    }
  }
  for (let i = 1; i < 2000; i++) {
    const a = start + (len * i) / 2000
    const x = cx + r * Math.cos(a)
    const y = cy + r * Math.sin(a)
    // Skip samples that sit on the boundary within rounding.
    const margin = Math.min(Math.abs(x - BOX.minX), Math.abs(x - BOX.maxX), Math.abs(y - BOX.minY), Math.abs(y - BOX.maxY))
    if (margin < 1e-6) continue
    expect(inSpan(a), `sample at ${a}`).toBe(inside(x, y, 0))
  }
  return spans
}

describe('arcSpansInBox', () => {
  it('a circle wholly inside is one full span', () => {
    expect(checkSpans(5, 2.5, 2, 1, TAU)).toEqual([1, TAU])
  })

  it('a circle around the box, or apart from it, has no span', () => {
    expect(checkSpans(5, 2.5, 100, 0, TAU)).toEqual([])
    expect(checkSpans(50, 2.5, 3, 0, TAU)).toEqual([])
  })

  it('a circle crossing the box yields the inside pieces in order along the arc', () => {
    expect(checkSpans(0, 0, 4, 0, TAU)).toHaveLength(2)
    // The right piece straddles the start angle of the circle: it still comes back as one span.
    expect(checkSpans(5, 2.5, 4, 0, TAU).length).toBe(4)
  })

  it('respects the angular range and negative sweeps', () => {
    const ccw = checkSpans(5, -1, 3, Math.PI / 4, Math.PI / 2)
    const cw = checkSpans(5, -1, 3, (3 * Math.PI) / 4, -Math.PI / 2)
    expect(cw).toHaveLength(2)
    expect(cw[0]).toBeCloseTo(ccw[0]!, 12)
    expect(cw[1]).toBeCloseTo(ccw[1]!, 12)
    expect(checkSpans(5, 2.5, 4, Math.PI / 2 - 0.1, 0.2)).toEqual([]) // the top piece lies above the box
  })

  it('stays exact for a huge radius seen through a tiny box', () => {
    const r = 1e7
    const spans = arcSpansInBox(BOX, 5, 2.5 - r, r, 0, Math.PI)
    expect(spans).toHaveLength(2)
    const [a, s] = spans as [number, number]
    for (const t of [0, s]) {
      const x = 5 + r * Math.cos(a + t)
      expect(x === 0 || x === 10 || Math.abs(x) < 1e-6 || Math.abs(x - 10) < 1e-6).toBe(true)
    }
  })
})
