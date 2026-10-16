import { describe, expect, it } from 'vitest'
import { applyAffine, mirroring, rotation, scaling, type Affine } from '../geom/vec'
import { typeOf } from './registry'
import { BY_BLOCK, SNAP, type Attrib, type Block, type Entity, type Insert } from './types'

const deg = (d: number): number => (d * Math.PI) / 180
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6 + 0

/** Block A, base (1, 1): a line on layer 0 in ByBlock, a circle on layer 2 in color 3, an arc on layer 0. */
const A: Block = {
  name: 'A', x: 1, y: 1,
  entities: [
    { type: 'line', layer: 0, color: BY_BLOCK, x0: 1, y0: 1, x1: 3, y1: 1 },
    { type: 'circle', layer: 2, color: 3, cx: 2, cy: 2, r: 1 },
    { type: 'arc', layer: 0, cx: 1, cy: 1, r: 2, a0: 0, a1: Math.PI / 2 },
  ],
}
const insert = (block: Block, extra: Partial<Insert> = {}): Insert => ({
  type: 'insert', id: 1, layer: 0, block, x: 0, y: 0, sx: 1, sy: 1, rotation: 0, cols: 1, rows: 1, dx: 0, dy: 0, ...extra,
})
/** Block B: A at (10, 0), turned 90°, twice as big, on layer 0 in ByBlock; and a line on layer 1, ByLayer. */
const B: Block = {
  name: 'B', x: 0, y: 0,
  entities: [
    { type: 'insert', layer: 0, color: BY_BLOCK, block: A, x: 10, y: 0, sx: 2, sy: 2, rotation: deg(90), cols: 1, rows: 1, dx: 0, dy: 0 },
    { type: 'line', layer: 1, x0: 0, y0: 0, x1: 0, y1: 5 },
  ],
}

type Prim = (string | number)[]
function prims(e: Entity, tol = 0): { prims: Prim[]; looks: Prim[] } {
  const out: Prim[] = []
  const looks: Prim[] = []
  let look: Prim = []
  typeOf(e).primitives(e, tol, {
    segment: (...a) => out.push(['segment', ...a.map(r6), ...look]),
    arc: (...a) => out.push(['arc', ...a.map(r6), ...look]),
    look(layer, color) {
      look = [layer, color ?? 'bylayer']
      looks.push(look)
    },
  })
  return { prims: out, looks }
}

describe('insert', () => {
  it('a nested block, scaled and turned, lands where the transforms say', () => {
    const e = insert(B, { x: 100, y: 50, sx: 0.5, sy: 0.5, rotation: deg(30), layer: 5, color: 6 })
    const { prims: p } = prims(e)
    const c = Math.cos(deg(30))
    const s = Math.sin(deg(30))
    // A's line: (0,0)-(2,0) from its base, ×2, turned 90°, at (10, 0) in B: (10,0)-(10,4); ×0.5, 30°, at (100, 50).
    expect(p).toContainEqual(['segment', r6(100 + 5 * c), r6(50 + 5 * s), r6(100 + 5 * c - 2 * s), r6(50 + 5 * s + 2 * c), 5, 6])
    // A's circle: centre (1,1) from the base → (−2, 2) + (10, 0) = (8, 2) in B → (4, 1) turned 30°; r = 1·2·0.5.
    expect(p).toContainEqual(['arc', r6(100 + 4 * c - s), r6(50 + 4 * s + c), 1, 0, r6(2 * Math.PI), 2, 3])
    // B's own line, on layer 1 ByLayer: (0,0)-(0,5) ×0.5 turned 30°.
    expect(p).toContainEqual(['segment', 100, 50, r6(100 - 2.5 * s), r6(50 + 2.5 * c), 1, 'bylayer'])
  })

  it('layer 0 and ByBlock take the insert, level after level; the others keep their own', () => {
    const { looks } = prims(insert(B, { layer: 5, color: 6 }))
    expect(looks).toContainEqual([5, 6])
    expect(looks).toContainEqual([2, 3])
    expect(looks).toContainEqual([1, 'bylayer'])
    // ByLayer on the insert: its ByBlock entities go ByLayer on the layer they end on.
    expect(prims(insert(A, { layer: 4 })).looks.slice(0, 2)).toEqual([[4, 'bylayer'], [2, 3]])
  })

  it('a grid (MINSERT) repeats the block along the turned axes', () => {
    const e = insert({ name: 'P', x: 0, y: 0, entities: [{ type: 'point', layer: 0, x: 0, y: 0 }] }, { x: 5, y: 5, rotation: deg(90), cols: 2, rows: 3, dx: 10, dy: 20 })
    const pts = prims(e).prims.map((p) => [p[1], p[2]])
    expect(pts).toHaveLength(6)
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) expect(pts).toContainEqual([r6(5 - 20 * j), r6(5 + 10 * i)])
    const ins: number[][] = []
    typeOf(e).snapPoints!(e, SNAP.INS, (x, y) => ins.push([r6(x), r6(y)]))
    expect(ins).toHaveLength(6)
  })

  it('scaled unevenly, a circle becomes chords on the ellipse, and only then is the insert free', () => {
    const O: Block = { name: 'O', x: 0, y: 0, entities: [{ type: 'circle', layer: 0, cx: 0, cy: 0, r: 1 }] }
    const L: Block = { name: 'L', x: 0, y: 0, entities: [{ type: 'line', layer: 0, x0: 0, y0: 0, x1: 1, y1: 1 }] }
    const uneven = insert(O, { sx: 2, sy: 1, rotation: deg(20) })
    expect(typeOf(uneven).free!(uneven)).toBe(true)
    expect(typeOf(insert(O, { sx: 2, sy: 2 })).free!(insert(O, { sx: 2, sy: 2 }))).toBe(false)
    expect(typeOf(insert(L, { sx: 2, sy: 1 })).free!(insert(L, { sx: 2, sy: 1 }))).toBe(false)
    const p = prims(uneven, 1e-6).prims
    expect(p.every((q) => q[0] === 'segment')).toBe(true)
    const back = (x: number, y: number): number => {
      const [c, s] = [Math.cos(deg(-20)), Math.sin(deg(-20))]
      return Math.hypot((c * x - s * y) / 2, s * x + c * y)
    }
    for (const q of p) expect(back(q[1] as number, q[2] as number)).toBeCloseTo(1, 5)
  })

  it('MOVE, ROTATE, SCALE and MIRROR move every primitive with it (a mirror flips the Y scale)', () => {
    const e = insert(B, { x: 3, y: -2, sx: 1.5, sy: 1.5, rotation: deg(10), cols: 2, rows: 2, dx: 30, dy: 40 })
    const mapped = (m: Affine): Prim[] =>
      prims(e).prims.map((p) => {
        if (p[0] === 'segment') {
          const a = applyAffine(m, p[1] as number, p[2] as number)
          const b = applyAffine(m, p[3] as number, p[4] as number)
          return ['segment', r6(a.x), r6(a.y), r6(b.x), r6(b.y)]
        }
        return ['arc', r6(applyAffine(m, p[1] as number, p[2] as number).x)]
      })
    for (const m of [rotation({ x: 1, y: 2 }, 33), scaling({ x: -4, y: 1 }, 2.5), mirroring({ x: 0, y: 0 }, { x: 1, y: 3 })]) {
      const t = typeOf(e).transform!(e, m)
      const got = prims(t).prims.map((p) => (p[0] === 'segment' ? p.slice(0, 5) : p.slice(0, 2)))
      const want = mapped(m)
      expect(got.length).toBe(want.length)
      got.forEach((g, i) => {
        expect(g[0]).toBe(want[i]![0])
        g.slice(1).forEach((v, k) => expect(v as number).toBeCloseTo(want[i]![k + 1] as number, 5))
      })
    }
    expect(typeOf(e).transform!(e, mirroring({ x: 0, y: 0 }, { x: 0, y: 1 })).sy).toBe(-1.5)
  })

  it('bbox holds every primitive; distance reaches into the block', () => {
    const e = insert(B, { x: 100, y: 50, sx: 0.5, sy: 0.5, rotation: deg(30) })
    const b = typeOf(e).bbox(e)
    for (const p of prims(e).prims) {
      if (p[0] !== 'segment') continue
      const [x, y] = [p[1] as number, p[2] as number]
      expect(x >= b.minX - 1e-6 && x <= b.maxX + 1e-6 && y >= b.minY - 1e-6 && y <= b.maxY + 1e-6).toBe(true)
    }
    // B's own line runs from (100, 50) along 120°: a point 1 off its middle, square to it.
    const mid = { x: 100 - 1.25 * Math.sin(deg(30)), y: 50 + 1.25 * Math.cos(deg(30)) }
    const off = { x: mid.x + Math.cos(deg(30)), y: mid.y + Math.sin(deg(30)) }
    expect(typeOf(e).distance(e, off)).toBeCloseTo(Math.min(1, typeOf(e).distance(e, off)), 9)
    expect(typeOf(e).distance(e, mid)).toBeCloseTo(0, 9)
  })

  it('snaps: INS at the insertion point, and the snap points of what it shows', () => {
    const e = insert(A, { x: 10, y: 20 })
    const out: number[][] = []
    typeOf(e).snapPoints!(e, SNAP.INS | SNAP.END | SNAP.CEN, (x, y, mode) => out.push([r6(x), r6(y), mode]))
    expect(out).toContainEqual([10, 20, SNAP.INS])
    expect(out).toContainEqual([10, 20, SNAP.END])
    expect(out).toContainEqual([12, 20, SNAP.END])
    expect(out).toContainEqual([11, 21, SNAP.CEN])
  })

  it('attributes: shown where they are, in their look (ByBlock takes the insert color), hidden ones not; moved with the insert', () => {
    const attrib = (value: string, x: number, extra: Partial<Attrib> = {}): Attrib => ({
      type: 'text', layer: 3, value, x, y: 0, x2: x, y2: 0, height: 1, rotation: 0, widthFactor: 1, oblique: 0,
      halign: 0, valign: 0, backward: false, upsideDown: false, tag: value.toUpperCase(), hidden: false, ...extra,
    })
    const e = insert(A, { x: 0, y: 0, layer: 5, color: 6, attribs: [attrib('a', 20), attrib('b', 30, { color: BY_BLOCK }), attrib('c', 40, { hidden: true })] })
    const glyphs: Prim[] = []
    let look: Prim = []
    typeOf(e).primitives(e, 0, {
      segment() {},
      arc() {},
      look: (layer, color) => void (look = [layer, color ?? 'bylayer']),
      glyph: (cp, x, y) => void glyphs.push([String.fromCodePoint(cp), r6(x), r6(y), ...look]),
    })
    expect(glyphs).toEqual([['a', 20, 0, 3, 'bylayer'], ['b', 30, 0, 3, 6]])
    // In the box and picked by its letters; the hidden one is neither.
    const b = typeOf(e).bbox(e)
    expect(b.maxX).toBeGreaterThan(30.5)
    expect(b.maxX).toBeLessThan(40)
    expect(typeOf(e).distance(e, { x: 30.3, y: 0.5 })).toBe(0)
    const ins: number[][] = []
    typeOf(e).snapPoints!(e, SNAP.INS, (x, y) => ins.push([r6(x), r6(y)]))
    expect(ins).toEqual([[20, 0], [30, 0], [0, 0]])
    // Moved, turned and scaled with the insert; a mirror keeps them readable.
    const moved = typeOf(e).transform!(e, rotation({ x: 0, y: 0 }, 90)) as Insert
    expect(moved.attribs!.map((t) => [t.tag, r6(t.x), r6(t.y), r6(t.rotation)])).toEqual([['A', 0, 20, r6(Math.PI / 2)], ['B', 0, 30, r6(Math.PI / 2)], ['C', 0, 40, r6(Math.PI / 2)]])
    const flipped = typeOf(e).transform!(e, mirroring({ x: 0, y: 0 }, { x: 0, y: 1 })) as Insert
    expect(flipped.attribs!.every((t) => !t.backward && t.rotation === 0 && t.x < 0)).toBe(true)
    expect(flipped.attribs![2]!.hidden).toBe(true)
  })

  it('a filled triangle of the block lands through the affine, stretch included; picked on its fill', () => {
    const S: Block = { name: 'S', x: 0, y: 0, entities: [{ type: 'solid', layer: 0, x0: 0, y0: 0, x1: 2, y1: 0, x2: 0, y2: 1, x3: 0, y3: 1 }] }
    for (const e of [insert(S, { x: 10, y: 5, rotation: deg(90) }), insert(S, { x: 10, y: 5, sx: 3, sy: 0.5 })]) {
      const m = { a: Math.cos(e.rotation) * e.sx, b: Math.sin(e.rotation) * e.sx, c: -Math.sin(e.rotation) * e.sy, d: Math.cos(e.rotation) * e.sy, e: 10, f: 5 }
      const tris: number[][] = []
      typeOf(e).primitives(e, 0, { segment() {}, arc() {}, tri: (...c) => tris.push(c.map(r6)) })
      const want = [[0, 0], [2, 0], [0, 1]].flatMap(([x, y]) => {
        const p = applyAffine(m, x!, y!)
        return [r6(p.x), r6(p.y)]
      })
      expect(tris).toEqual([want])
      // Inside the triangle, a third of the way from each corner.
      const c = { x: (want[0]! + want[2]! + want[4]!) / 3, y: (want[1]! + want[3]! + want[5]!) / 3 }
      expect(typeOf(e).distance(e, c)).toBeCloseTo(0, 9)
    }
  })

  it('validate: non-zero scales and a grid of whole copies', () => {
    expect(typeOf(insert(A)).validate!(insert(A))).toBeUndefined()
    expect(typeOf(insert(A)).validate!(insert(A, { sx: 0 }))).toMatch(/scale/)
    expect(typeOf(insert(A)).validate!(insert(A, { cols: 0 }))).toMatch(/copies/)
  })
})
