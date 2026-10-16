import { describe, expect, it } from 'vitest'
import { arcBBox, arcDistance, arcSweep, bulgeToArc, onArc } from './curve'
import { TAU, eq, normAngle } from './tol'
import { segmentDistance } from './vec'

const deg = (d: number): number => (d * Math.PI) / 180

describe('tolerance and angles', () => {
  it('eq is relative for large magnitudes and absolute near zero', () => {
    expect(eq(7_400_000, 7_400_000 + 1e-3)).toBe(true)
    expect(eq(7_400_000, 7_400_000 + 1e-2)).toBe(false)
    expect(eq(0, 1e-10)).toBe(true)
    expect(eq(0, 1e-8)).toBe(false)
  })

  it('normAngle maps to [0, 2π)', () => {
    expect(normAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 12)
    expect(normAngle(5 * Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(normAngle(TAU)).toBe(0)
    expect(normAngle(-1e-17)).toBe(0)
  })

  it('arcSweep is counter-clockwise in (0, 2π], equal angles giving a full circle', () => {
    expect(arcSweep(deg(350), deg(10))).toBeCloseTo(deg(20), 12)
    expect(arcSweep(deg(10), deg(350))).toBeCloseTo(deg(340), 12)
    expect(arcSweep(1, 1)).toBe(TAU)
  })

  it('onArc accepts negative sweeps', () => {
    expect(onArc(deg(45), 0, deg(90))).toBe(true)
    expect(onArc(deg(-45), 0, deg(90))).toBe(false)
    expect(onArc(deg(-45), 0, deg(-90))).toBe(true)
    expect(onArc(deg(200), 0, TAU)).toBe(true)
  })
})

describe('segmentDistance', () => {
  it('is perpendicular inside the span and to the nearest end beyond it', () => {
    expect(segmentDistance(5, 3, 0, 0, 10, 0)).toBe(3)
    expect(segmentDistance(13, 4, 0, 0, 10, 0)).toBe(5)
    expect(segmentDistance(-3, -4, 0, 0, 10, 0)).toBe(5)
    expect(segmentDistance(3, 4, 0, 0, 0, 0)).toBe(5)
  })
})

describe('bulgeToArc', () => {
  it('bulge 1 is a semicircle, counter-clockwise from the start', () => {
    const a = bulgeToArc({ x: 0, y: 0 }, { x: 2, y: 0 }, 1)!
    expect(a.cx).toBeCloseTo(1, 12)
    expect(a.cy).toBeCloseTo(0, 12)
    expect(a.r).toBeCloseTo(1, 12)
    expect(a.a0).toBeCloseTo(Math.PI, 12)
    expect(a.sweep).toBeCloseTo(Math.PI, 12)
  })

  it('negative bulge turns clockwise', () => {
    const a = bulgeToArc({ x: 0, y: 0 }, { x: 2, y: 0 }, -1)!
    expect(a.sweep).toBeCloseTo(-Math.PI, 12)
    // Mid-angle of a clockwise half turn from π lies at π/2: the top.
    expect(a.cy + a.r * Math.sin(a.a0 + a.sweep / 2)).toBeCloseTo(1, 12)
  })

  it('ends on both vertices for any bulge', () => {
    for (const b of [0.01, 0.3, -0.7, 1, 2.5, -4]) {
      const p = { x: 7_400_000.25, y: 9_100_000.5 }
      const q = { x: 7_400_003, y: 9_100_001 }
      const a = bulgeToArc(p, q, b)!
      const end = a.a0 + a.sweep
      expect(Math.abs(a.cx + a.r * Math.cos(a.a0) - p.x)).toBeLessThan(1e-8)
      expect(Math.abs(a.cy + a.r * Math.sin(a.a0) - p.y)).toBeLessThan(1e-8)
      expect(Math.abs(a.cx + a.r * Math.cos(end) - q.x)).toBeLessThan(1e-8)
      expect(Math.abs(a.cy + a.r * Math.sin(end) - q.y)).toBeLessThan(1e-8)
      expect(a.sweep).toBeCloseTo(4 * Math.atan(b), 12)
    }
  })

  it('a quarter turn has its centre on the corner', () => {
    const a = bulgeToArc({ x: 1, y: 0 }, { x: 0, y: 1 }, Math.tan(Math.PI / 8))!
    expect(a.cx).toBeCloseTo(0, 12)
    expect(a.cy).toBeCloseTo(0, 12)
    expect(a.r).toBeCloseTo(1, 12)
  })

  it('treats a bulge too small to bend the chord measurably as straight', () => {
    // Below 1e-8 the sagitta (|bulge|·chord/2) is smaller than the rounding error of an arc with that radius.
    expect(bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, 1e-15)).toBeNull()
    expect(bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, -5e-9)).toBeNull()
    const a = bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, 2e-8)!
    expect(Math.abs(a.cx + a.r * Math.cos(a.a0))).toBeLessThan(1e-6)
  })

  it('is null for a zero bulge or a zero chord', () => {
    expect(bulgeToArc({ x: 0, y: 0 }, { x: 1, y: 0 }, 0)).toBeNull()
    expect(bulgeToArc({ x: 1, y: 1 }, { x: 1, y: 1 }, 1)).toBeNull()
  })
})

describe('arcBBox', () => {
  it('includes the quadrant point when the arc crosses 0°', () => {
    const b = arcBBox(0, 0, 1, deg(350), deg(20))
    expect(b.maxX).toBe(1)
    expect(b.minX).toBeCloseTo(Math.cos(deg(10)), 12)
    expect(b.minY).toBeCloseTo(-Math.sin(deg(10)), 12)
    expect(b.maxY).toBeCloseTo(Math.sin(deg(10)), 12)
  })

  it('is the full square for a circle and handles negative sweeps', () => {
    expect(arcBBox(5, 6, 2, 0, TAU)).toEqual({ minX: 3, minY: 4, maxX: 7, maxY: 8 })
    const b = arcBBox(0, 0, 1, 0, -Math.PI / 2)
    expect([b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 1e12) / 1e12)).toEqual([0, -1, 1, 0])
  })
})

describe('arcDistance', () => {
  it('is radial inside the sweep and to the nearest end outside it', () => {
    expect(arcDistance(0, 3, 0, 0, 1, 0, Math.PI)).toBeCloseTo(2, 12)
    expect(arcDistance(0, -3, 0, 0, 1, 0, Math.PI)).toBeCloseTo(Math.hypot(1, 3), 12)
    expect(arcDistance(0, 0, 0, 0, 1, 0, TAU)).toBe(1)
  })
})
