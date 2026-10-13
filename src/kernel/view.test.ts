import { describe, expect, it } from 'vitest'
import {
  MAX_SCALE,
  MIN_SCALE,
  fit,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type ViewState,
} from './view'

const base: ViewState = { cx: 7.4e6, cy: 9.1e6, scale: 37.5, width: 1280, height: 800, dpr: 1.25 }

describe('ViewState', () => {
  it('orients Y up in the world and down on screen', () => {
    expect(worldToScreen(base, base.cx, base.cy)).toEqual({ x: 640, y: 400 })
    const p = worldToScreen(base, base.cx + 1, base.cy + 1)
    expect(p.x).toBeCloseTo(640 + 37.5, 6)
    expect(p.y).toBeCloseTo(400 - 37.5, 6)
  })

  it('round-trips screen -> world -> screen', () => {
    for (const [sx, sy] of [[0, 0], [640, 400], [1280, 800], [123.5, 77.25]] as const) {
      const w = screenToWorld(base, sx, sy)
      const s = worldToScreen(base, w.x, w.y)
      expect(Math.abs(s.x - sx)).toBeLessThan(1e-6)
      expect(Math.abs(s.y - sy)).toBeLessThan(1e-6)
    }
  })

  it('zoomAt keeps the world point under the cursor fixed', () => {
    let v: ViewState = { ...base, scale: 10 }
    const anchor = screenToWorld(v, 1000, 150)
    const factors = [...Array<number>(50).fill(1.1), ...Array<number>(50).fill(1 / 1.1)]
    for (const f of factors) {
      const next = zoomAt(v, 1000, 150, f)
      expect(next.scale).toBeCloseTo(v.scale * f, 9)
      v = next
      const w = screenToWorld(v, 1000, 150)
      expect(Math.abs(w.x - anchor.x)).toBeLessThan(1e-6)
      expect(Math.abs(w.y - anchor.y)).toBeLessThan(1e-6)
    }
  })

  it('zoomAt clamps scale and still anchors the cursor', () => {
    const v: ViewState = { ...base, scale: 10 }
    const anchor = screenToWorld(v, 1000, 150)
    for (const [factor, expected] of [[1e12, MAX_SCALE], [1e-12, MIN_SCALE]] as const) {
      const z = zoomAt(v, 1000, 150, factor)
      expect(z.scale).toBe(expected)
      const w = screenToWorld(z, 1000, 150)
      expect(Math.abs(w.x - anchor.x)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(anchor.x)))
      expect(Math.abs(w.y - anchor.y)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(anchor.y)))
    }
  })

  it('zoomAt returns the same view for invalid factors', () => {
    for (const f of [0, -2, NaN, Infinity]) expect(zoomAt(base, 1000, 150, f)).toBe(base)
  })

  it('panBy drags the content by the pixel delta', () => {
    const w = screenToWorld(base, 100, 100)
    const v = panBy(base, 30, -20)
    const s = worldToScreen(v, w.x, w.y)
    expect(Math.abs(s.x - 130)).toBeLessThan(1e-6)
    expect(Math.abs(s.y - 80)).toBeLessThan(1e-6)
    expect(v.scale).toBe(base.scale)
  })

  it('fit frames the bbox with a pixel margin', () => {
    const bbox = { minX: 7.4e6, minY: 9.1e6, maxX: 7.4e6 + 200, maxY: 9.1e6 + 50 }
    const v = fit(base, bbox, 40)
    expect(v.scale).toBe(6)
    const c = worldToScreen(v, 7.4e6 + 100, 9.1e6 + 25)
    expect(Math.abs(c.x - 640)).toBeLessThan(1e-6)
    expect(Math.abs(c.y - 400)).toBeLessThan(1e-6)
    expect(Math.abs(worldToScreen(v, bbox.minX, bbox.minY).x - 40)).toBeLessThan(1e-6)
    expect(Math.abs(worldToScreen(v, bbox.maxX, bbox.minY).x - 1240)).toBeLessThan(1e-6)
  })

  it('fit handles degenerate bboxes', () => {
    const line = fit(base, { minX: 5, minY: 0, maxX: 5, maxY: 50 }, 40)
    expect(line.scale).toBe(14.4)
    const dot = fit(base, { minX: 5, minY: 6, maxX: 5, maxY: 6 }, 40)
    expect(dot.scale).toBe(base.scale)
    const c = worldToScreen(dot, 5, 6)
    expect(Math.abs(c.x - 640)).toBeLessThan(1e-6)
    expect(Math.abs(c.y - 400)).toBeLessThan(1e-6)
  })

  it('never mutates the input and preserves width, height and dpr', () => {
    const v = Object.freeze({ ...base })
    const bbox = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    for (const out of [zoomAt(v, 10, 10, 2), panBy(v, 5, 5), fit(v, bbox, 10)]) {
      expect(out).not.toBe(v)
      expect([out.width, out.height, out.dpr]).toEqual([v.width, v.height, v.dpr])
    }
  })
})
