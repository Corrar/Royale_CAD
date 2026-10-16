import { describe, expect, it } from 'vitest'
import { applyAffine, mirroring, rotation, scaling, translation } from '../geom/vec'
import { advanceOf, DESCENT } from '../text/font'
import { typeOf } from './registry'
import { SNAP, type Block, type Entity, type Insert, type MText, type Text } from './types'

const H = advanceOf(72)
const text = (extra: Partial<Text> = {}): Text => ({
  type: 'text', id: 1, layer: 0, value: 'HH', x: 10, y: 20, x2: 10, y2: 20, height: 2, rotation: 0, widthFactor: 1, oblique: 0,
  halign: 0, valign: 0, backward: false, upsideDown: false, ...extra,
})
const mtext = (extra: Partial<MText> = {}): MText => ({ type: 'mtext', id: 2, layer: 0, value: 'HH\\PH', x: 0, y: 0, height: 1, width: 0, attachment: 1, rotation: 0, spacing: 1, ...extra })

type G = [number, number, number, number, number, number, number]
/** Rounded to compare, −0 as 0. */
const fixed = (vs: number[]): number[] => vs.map((v) => +v.toFixed(9) + 0)
const fixedRows = (rows: number[][]): number[][] => rows.map(fixed)
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

  it('aligned and fit take their direction from their points, not from a 50 that disagrees (ezdxf writes none)', () => {
    for (const halign of [3, 5]) {
      const t = text({ halign, x: 0, y: 0, x2: 10, y2: 10, rotation: 0 })
      for (const m of [translation(5, 0), rotation({ x: 0, y: 0 }, 90), rotation({ x: 3, y: -2 }, 33), mirroring({ x: 50, y: 0 }, { x: 50, y: 1 })]) {
        const after = typeOf(t).transform!(t, m)
        const [p1, p2] = [applyAffine(m, 0, 0), applyAffine(m, 10, 10)]
        // The points go where m puts them (a mirror reads them the other way round); the letters run along them.
        const ends = [[after.x, after.y], [after.x2, after.y2]].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
        const want = [[p1.x, p1.y], [p2.x, p2.y]].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
        expect(fixed(ends.flat())).toEqual(fixed(want.flat()))
        const g = glyphs(after)[0]!
        expect(Math.abs(g[3] * (after.y2 - after.y) - g[4] * (after.x2 - after.x))).toBeLessThan(1e-9)
        expect(after.rotation).toBeCloseTo(Math.atan2(after.y2 - after.y, after.x2 - after.x) + (after.y2 < after.y ? 2 * Math.PI : 0), 9)
      }
    }
  })

  it('MIRROR puts a backward or upside-down text where the mirror puts its box, flags kept', () => {
    const across = mirroring({ x: 50, y: 0 }, { x: 50, y: 1 })
    for (const flags of [{ backward: true }, { upsideDown: true }, { backward: true, upsideDown: true }, { backward: true, halign: 2 }]) {
      const t = text(flags)
      const b = typeOf(t).bbox(t)
      const mirrored = typeOf(t).transform!(t, across)
      const a = typeOf(mirrored).bbox(mirrored)
      expect([mirrored.backward, mirrored.upsideDown]).toEqual([t.backward, t.upsideDown])
      expect(fixed([a.minX, a.maxX, a.minY, a.maxY])).toEqual(fixed([100 - b.maxX, 100 - b.minX, b.minY, b.maxY]))
    }
  })

  it('an underline is a segment, with the text and through the insert it is in', () => {
    const segments = (e: Entity): number[][] => {
      const out: number[][] = []
      typeOf(e).primitives(e, 0, { segment: (...a) => out.push(a.map((v) => +v.toFixed(9) + 0)), arc() {} })
      return out
    }
    const t = text({ value: '%%uHH', x: 0, y: 0 })
    expect(segments(t)).toEqual(fixedRows([[0, -0.4, 4 * H, -0.4]]))
    const block: Block = { name: 'U', x: 0, y: 0, entities: [{ ...t, id: undefined } as never] }
    const ins: Insert = { type: 'insert', id: 3, layer: 0, block, x: 100, y: 0, sx: 2, sy: 3, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0 }
    expect(segments(ins)).toEqual(fixedRows([[100, -1.2, 100 + 8 * H, -1.2]]))
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

  it('is picked by clicking its letters, however the insert scales them', () => {
    const block: Block = { name: 'T', x: 0, y: 0, entities: [{ ...text({ x: 0, y: 0, value: 'HHHH', height: 1 }), id: undefined } as never] }
    for (const [sx, sy] of [[2, 2], [2, 1], [1, -3]]) {
      const ins: Insert = { type: 'insert', id: 3, layer: 0, block, x: 100, y: 0, sx, sy, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0 }
      const top = Math.max(sy, -sy * DESCENT)
      expect(typeOf(ins).distance(ins, { x: 101, y: sy / 2 })).toBe(0)
      // One unit past the cap line (or, mirrored, past the descent): as far as that from the letters.
      expect(typeOf(ins).distance(ins, { x: 101, y: top + 1 })).toBeCloseTo(1, 9)
    }
  })
})
