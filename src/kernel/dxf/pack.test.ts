import { describe, expect, it } from 'vitest'
import type { Draft } from '../document'
import { TRUE_COLOR } from '../color'
import { BY_BLOCK, type Block, type Insert } from '../entity/types'
import { packBuffers, packDrafts, unpackDrafts } from './pack'

const DRAFTS: Draft[] = [
  { type: 'line', layer: 1, color: 3, x0: 0.1, y0: -2, x1: 7_400_000.123, y1: 9_100_000 },
  { type: 'circle', layer: 0, cx: 5, cy: 6, r: 2.5 },
  { type: 'arc', layer: 2, color: TRUE_COLOR | 0x123456, cx: 0, cy: 0, r: 3, a0: Math.PI / 2, a1: Math.PI },
  { type: 'point', layer: 0, x: 7, y: 8 },
  { type: 'polyline', layer: 0, pts: new Float64Array([0, 0, 10, 0, 10, 10]), bulges: new Float64Array([0, 1, 0]), closed: true },
  { type: 'polyline', layer: 3, pts: new Float64Array([1, 2]), bulges: null, closed: false },
  { type: 'polyline', layer: 0, pts: new Float64Array([0, 0, 10, 0]), bulges: null, closed: false, widths: new Float64Array([0.5, 0.5, 2, 0]), startWidth: 0.2, endWidth: 0.4 },
  { type: 'polyline', layer: 0, pts: new Float64Array([0, 5, 10, 5]), bulges: null, closed: false, startWidth: 0.3, endWidth: 0.3 },
  { type: 'opaque', layer: 1, name: 'HATCH', raw: '  0\r\nHATCH\r\n' },
  { type: 'ellipse', layer: 2, color: 5, cx: 1, cy: 2, mx: 3, my: 4, ratio: 0.5, t0: 0.25, t1: 6 },
  { type: 'text', layer: 0, value: '%%c50 Ação', x: 1, y: 2, x2: 3, y2: 4, height: 2.5, rotation: 0.3, widthFactor: 0.8, oblique: 0.1, halign: 3, valign: 0, backward: true, upsideDown: false },
  { type: 'text', layer: 0, value: 'styled', x: 1, y: 2, x2: 1, y2: 2, height: 1, rotation: 0, widthFactor: 1, oblique: 0, halign: 0, valign: 0, backward: false, upsideDown: false, style: 'ROMANS' },
  { type: 'mtext', layer: 1, value: '{\\fArial;Hi}\\PThere', x: 5, y: 6, height: 1, width: 40, attachment: 5, rotation: 0, spacing: 1.5 },
  { type: 'mtext', layer: 1, value: 'styled', x: 5, y: 6, height: 1, width: 0, attachment: 1, rotation: 0, spacing: 1, style: 'ROMANS' },
  { type: 'solid', layer: 2, color: 1, x0: 0.5, y0: -1, x1: 7_400_000.25, y1: 0, x2: 3, y2: 4, x3: 3, y3: 4 },
  { type: 'spline', layer: 0, degree: 2, closed: false, knots: Float64Array.of(0, 0, 0, 1, 1, 1), ctrl: Float64Array.of(0, 0, 1, 2, 3, 0), weights: null },
  { type: 'spline', layer: 1, degree: 1, closed: true, knots: Float64Array.of(0, 0, 1, 1), ctrl: Float64Array.of(0, 0, 1, 2), weights: Float64Array.of(1, 3) },
]

const A: Block = {
  name: 'A', x: 1, y: 1,
  entities: [
    { type: 'line', layer: 0, color: BY_BLOCK, x0: 1, y0: 1, x1: 3, y1: 1 },
    { type: 'circle', layer: 2, cx: 0, cy: 0, r: 1 },
    { type: 'solid', layer: 0, x0: 0, y0: 0, x1: 1, y1: 0, x2: 0, y2: 1, x3: 1, y3: 1 },
  ],
}
const B: Block = {
  name: 'B', x: 0, y: 0,
  entities: [{ type: 'insert', layer: 0, color: BY_BLOCK, block: A, x: 10, y: 0, sx: 2, sy: 2, rotation: 1, cols: 1, rows: 1, dx: 0, dy: 0 }],
}
const ins = (block: Block, x: number): Omit<Insert, 'id'> => ({ type: 'insert', layer: 1, block, x, y: 0, sx: 1, sy: -1, rotation: 0.5, cols: 2, rows: 3, dx: 4, dy: 5 })

describe('packDrafts', () => {
  it('carries inserts with their blocks, nested ones too; one block read back is one object', () => {
    const drafts = [ins(B, 1), ins(A, 2), ins(B, 3)]
    const p = structuredClone(packDrafts(drafts))
    expect(p.n).toBe(3)
    const back = unpackDrafts(p, 0, p.n) as Omit<Insert, 'id'>[]
    expect(back).toEqual(drafts)
    expect(back[0]!.block).toBe(back[2]!.block)
    expect((back[0]!.block.entities[0] as Omit<Insert, 'id'>).block).toBe(back[1]!.block)
    expect(unpackDrafts(p, 1, 3)[0]).toEqual(drafts[1])
  })

  it('carries the attributes of an insert: tag, layer, color (ByBlock and ByLayer told apart), hidden, style', () => {
    const attrib = { type: 'text', layer: 2, value: 'D1', x: 1, y: 2, x2: 3, y2: 4, height: 0.5, rotation: 0.25, widthFactor: 0.9, oblique: 0.1, halign: 5, valign: 0, backward: false, upsideDown: true, tag: 'NUM', hidden: false } as const
    const drafts = [{ ...ins(A, 1), attribs: [attrib, { ...attrib, color: BY_BLOCK, tag: 'NOTE', hidden: true, value: '' }, { ...attrib, color: 4, style: 'ROMANS' }] }, ins(A, 2)]
    const p = structuredClone(packDrafts(drafts))
    expect(unpackDrafts(p, 0, p.n)).toEqual(drafts)
  })

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
