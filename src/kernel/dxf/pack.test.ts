import { describe, expect, it } from 'vitest'
import type { Draft } from '../document'
import { TRUE_COLOR } from '../color'
import { packBuffers, packDrafts, unpackDrafts } from './pack'

const DRAFTS: Draft[] = [
  { type: 'line', layer: 1, color: 3, x0: 0.1, y0: -2, x1: 7_400_000.123, y1: 9_100_000 },
  { type: 'circle', layer: 0, cx: 5, cy: 6, r: 2.5 },
  { type: 'arc', layer: 2, color: TRUE_COLOR | 0x123456, cx: 0, cy: 0, r: 3, a0: Math.PI / 2, a1: Math.PI },
  { type: 'point', layer: 0, x: 7, y: 8 },
  { type: 'polyline', layer: 0, pts: new Float64Array([0, 0, 10, 0, 10, 10]), bulges: new Float64Array([0, 1, 0]), closed: true },
  { type: 'polyline', layer: 3, pts: new Float64Array([1, 2]), bulges: null, closed: false },
  { type: 'opaque', layer: 1, name: 'HATCH', raw: '  0\r\nHATCH\r\n' },
  { type: 'ellipse', layer: 2, color: 5, cx: 1, cy: 2, mx: 3, my: 4, ratio: 0.5, t0: 0.25, t1: 6 },
  { type: 'spline', layer: 0, degree: 2, closed: false, knots: Float64Array.of(0, 0, 0, 1, 1, 1), ctrl: Float64Array.of(0, 0, 1, 2, 3, 0), weights: null },
  { type: 'spline', layer: 1, degree: 1, closed: true, knots: Float64Array.of(0, 0, 1, 1), ctrl: Float64Array.of(0, 0, 1, 2), weights: Float64Array.of(1, 3) },
]

describe('packDrafts', () => {
  it('unpacks to the same drafts, whole or in slices', () => {
    const p = structuredClone(packDrafts(DRAFTS))
    expect(unpackDrafts(p, 0, p.n)).toEqual(DRAFTS)
    expect([...unpackDrafts(p, 0, 3), ...unpackDrafts(p, 3, 5), ...unpackDrafts(p, 5, 8), ...unpackDrafts(p, 8, p.n)]).toEqual(DRAFTS)
  })

  it('is a handful of buffers that can be transferred', () => {
    const p = packDrafts(DRAFTS)
    expect(packBuffers(p)).toHaveLength(5)
    expect(p.names).toEqual(['HATCH'])
    expect(unpackDrafts(packDrafts([]), 0, 0)).toEqual([])
  })
})
