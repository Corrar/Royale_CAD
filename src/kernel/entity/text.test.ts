import { describe, expect, it } from 'vitest'
import { applyAffine, mirroring, rotation, scaling } from '../geom/vec'
import { advanceOf } from '../text/font'
import { typeOf } from './registry'
import { SNAP, type Block, type Entity, type Insert, type MText, type Text } from './types'

const H = advanceOf(72)
const text = (extra: Partial<Text> = {}): Text => ({
  type: 'text', id: 1, layer: 0, value: 'HH', x: 10, y: 20, x2: 10, y2: 20, height: 2, rotation: 0, widthFactor: 1, oblique: 0,
  halign: 0, valign: 0, backward: false, upsideDown: false, ...extra,
})
const mtext = (extra: Partial<MText> = {}): MText => ({ type: 'mtext', id: 2, layer: 0, value: 'HH\\PH', x: 0, y: 0, height: 1, width: 0, attachment: 1, rotation: 0, spacing: 1, ...extra })

type G = [number, number, number, number, number, number, number]
const glyphs = (e: Entity): G[] => {
  const out: G[] = []
  typeOf(e).primitives(e, 0, { segment() {}, arc() {}, glyph: (...a) => out.push(a) })
  return out
}

describe('text', () => {
  it('draws a glyph per letter along its frame; its box is the bbox; distance is 0 inside', () => {
    const t = text()
    expect(glyphs(t)).toEqual([[72, 10, 20, 2, 0, 0, 2], [72, 10 + 2 * H, 20, 2, 0, 0, 2]])
    const b = typeOf(t).bbox(t)
    expect(b.minX).toBe(10)
    expect(b.maxX).toBeCloseTo(10 + 4 * H, 12)
    expect(b.maxY).toBeCloseTo(22, 12)
    expect(typeOf(t).distance(t, { x: 11, y: 21 })).toBe(0)
    expect(typeOf(t).distance(t, { x: 11, y: 25 })).toBeCloseTo(3, 12)
  })

  it('ROTATE and SCALE move the glyphs with it; MIRROR keeps it readable in the mirrored place', () => {
    const t = text()
    for (const m of [rotation({ x: 0, y: 0 }, 30), scaling({ x: 5, y: 5 }, 3)]) {
      const before = glyphs(t).map((g) => applyAffine(m, g[1], g[2]))
      const after = glyphs(typeOf(t).transform!(t, m))
      after.forEach((g, i) => {
        expect(g[1]).toBeCloseTo(before[i]!.x, 9)
        expect(g[2]).toBeCloseTo(before[i]!.y, 9)
      })
    }
    const mirrored = typeOf(t).transform!(t, mirroring({ x: 50, y: 0 }, { x: 50, y: 1 }))
    expect(mirrored.rotation).toBeCloseTo(0, 12)
    const b = typeOf(mirrored).bbox(mirrored)
    expect(b.minX).toBeCloseTo(100 - (10 + 4 * H), 9)
    expect(b.maxX).toBeCloseTo(90, 9)
  })

  it('snaps INS at its point; validate wants a height and a width factor', () => {
    const out: number[][] = []
    typeOf(text()).snapPoints!(text(), SNAP.INS | SNAP.END, (x, y, mode) => out.push([x, y, mode]))
    expect(out).toEqual([[10, 20, SNAP.INS]])
    expect(typeOf(text()).validate!(text({ height: 0 }))).toMatch(/height/)
    expect(typeOf(text()).validate!(text({ widthFactor: 0 }))).toMatch(/width/)
  })
})

describe('mtext', () => {
  it('paragraphs as lines down from the point; box, transform, snap', () => {
    const m = mtext()
    expect(glyphs(m).map((g) => [g[0], g[2]])).toEqual([[72, -1], [72, -1], [72, -1 - 5 / 3]])
    const b = typeOf(m).bbox(m)
    expect(b.maxY).toBe(0)
    expect(b.maxX).toBeCloseTo(2 * H, 12)
    const moved = typeOf(m).transform!(m, scaling({ x: 0, y: 0 }, 2))
    expect([moved.height, moved.x, moved.y]).toEqual([2, 0, 0])
    expect(typeOf(m).validate!(mtext({ attachment: 10 }))).toMatch(/attachment/)
  })
})

describe('text in a block', () => {
  it('goes through the insert: its glyphs take the transform of the insert, even an uneven one', () => {
    const block: Block = { name: 'T', x: 0, y: 0, entities: [{ ...text({ x: 0, y: 0 }), id: undefined } as never] }
    const ins: Insert = { type: 'insert', id: 3, layer: 0, block, x: 100, y: 0, sx: 2, sy: 3, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0 }
    expect(glyphs(ins)[0]).toEqual([72, 100, 0, 4, 0, 0, 6])
  })
})
