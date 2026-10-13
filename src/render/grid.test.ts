import { describe, expect, it } from 'vitest'
import type { ViewState } from '../kernel/view'
import { gridParams } from './grid'

const view = (scale: number, cx = 0, cy = 0): ViewState => ({ cx, cy, scale, width: 800, height: 600, dpr: 1 })

describe('gridParams', () => {
  it('scale 1 gives step 10 at exactly 10 px', () => {
    const g = gridParams(view(1))
    expect(g.step).toBe(10)
    expect(g.spacingPx).toBe(10)
    expect(g.t).toBe(0)
  })

  it('keeps spacing in [10, 100) with a power-of-ten step across the zoom range', () => {
    for (let k = -42; k <= 42; k++) {
      const g = gridParams(view(10 ** (k / 7)))
      expect(g.spacingPx).toBeGreaterThanOrEqual(10 - 1e-9)
      expect(g.spacingPx).toBeLessThan(100 + 1e-6)
      const e = Math.log10(g.step)
      expect(Math.abs(e - Math.round(e))).toBeLessThan(1e-9)
      expect(g.t).toBeGreaterThanOrEqual(0)
      expect(g.t).toBeLessThanOrEqual(1)
    }
  })

  it('computes the phase in f64 at UTM-sized coordinates', () => {
    const g = gridParams(view(200, 7_400_000.25, 9_100_000.75))
    expect(g.step).toBeCloseTo(0.1, 12)
    expect(g.spacingPx).toBeCloseTo(20, 9)
    expect(g.phaseMinor.x).toBeCloseTo(10, 3)
    expect(g.phaseMinor.y).toBeCloseTo(10, 3)
    expect(g.phaseMajor.x).toBeCloseTo(50, 3)
    expect(g.phaseMajor.y).toBeCloseTo(150, 3)
  })

  it('uses a positive modulo for negative coordinates', () => {
    expect(gridParams(view(200, -0.03)).phaseMinor.x).toBeCloseTo(14, 3)
  })

  it('fade reaches 1 by t = 0.3 and blend only rises after t = 0.7', () => {
    // spacingPx = 10 * 10^t
    const at = (t: number) => gridParams(view(10 ** t))
    expect(at(0).fade).toBe(0)
    expect(at(0.3).fade).toBeCloseTo(1, 9)
    expect(at(0.9).fade).toBe(1)
    expect(at(0.7).blend).toBe(0)
    expect(at(0.5).blend).toBe(0)
    expect(at(0.85).blend).toBeGreaterThan(0.3)
    expect(at(0.85).blend).toBeLessThan(0.7)
    expect(at(0.999).blend).toBeGreaterThan(0.99)
  })
})
