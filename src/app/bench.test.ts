import { describe, expect, it } from 'vitest'
import type { ViewState } from '../kernel/view'
import { benchView, mulberry32, percentile, regimeP50 } from './bench'

describe('percentile', () => {
  it('interpolates linearly', () => {
    const s = [1, 2, 3, 4, 5]
    expect(percentile(s, 0)).toBe(1)
    expect(percentile(s, 0.5)).toBe(3)
    expect(percentile(s, 1)).toBe(5)
    expect(percentile(s, 0.95)).toBeCloseTo(4.8, 10)
  })
})

describe('mulberry32', () => {
  it('is deterministic and stays in [0, 1)', () => {
    const a = mulberry32(1)
    const b = mulberry32(1)
    for (let i = 0; i < 1000; i++) {
      const v = a()
      expect(v).toBe(b())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('benchView', () => {
  const base: ViewState = { cx: 0, cy: 0, scale: 0.5, width: 1920, height: 1080, dpr: 1.25 }
  it('starts at the base scale and peaks at 20x halfway', () => {
    expect(benchView(0, 300, base).scale).toBeCloseTo(base.scale, 10)
    expect(benchView(150, 300, base).scale).toBeCloseTo(20 * base.scale, 10)
  })
  it('keeps the viewport fields', () => {
    const v = benchView(77, 300, base)
    expect([v.width, v.height, v.dpr]).toEqual([1920, 1080, 1.25])
  })
})

describe('regimeP50', () => {
  const scales = [1, 1.4, 2, 10, 20]
  const samples = [5, 1, 99, 3, 7]
  it('takes the median of the frames at or above 10x the base', () => {
    expect(regimeP50(samples, scales, 1, 'zoomedIn')).toBe(5)
  })
  it('takes the median of the frames at or below 1.5x the base', () => {
    expect(regimeP50(samples, scales, 1, 'allVisible')).toBe(3)
  })
  it('is 0 when no frame is in the regime', () => {
    expect(regimeP50([4], [3], 1, 'zoomedIn')).toBe(0)
  })
})
