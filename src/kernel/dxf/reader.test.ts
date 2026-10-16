import { describe, expect, it } from 'vitest'
import { TRUE_COLOR } from '../color'
import { BY_BLOCK, type Arc, type Circle, type Ellipse, type Entity, type Insert, type Line, type Opaque, type Point, type Polyline, type Spline } from '../entity/types'
import { createDocument } from '../document'
import { drawingFrom, loader, parseDxf, readDxf } from './reader'

type G = (string | number)[]

/** DXF text from groups given as code, value, code, value…, laid out as AutoCAD writes it (CRLF, padded codes). */
const lines = (gs: G): string => {
  const out: string[] = []
  for (let i = 0; i < gs.length; i += 2) out.push(String(gs[i]).padStart(3, ' '), String(gs[i + 1]))
  return out.map((l) => l + '\r\n').join('')
}

const LAYER_TABLE = (...entries: G[]): G => [0, 'TABLE', 2, 'LAYER', 70, entries.length, ...entries.flatMap((e) => [0, 'LAYER', ...e]), 0, 'ENDTAB']

function file(entities: G, tables: G = [], header: G = [9, '$ACADVER', 1, 'AC1015', 9, '$HANDSEED', 5, 'FF']): string {
  return lines([
    0, 'SECTION', 2, 'HEADER', ...header, 0, 'ENDSEC',
    0, 'SECTION', 2, 'TABLES', ...tables, 0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES', ...entities, 0, 'ENDSEC',
    0, 'EOF',
  ])
}

const all = (d: ReturnType<typeof readDxf>): Entity[] => [...d.doc.entities()]
const r9 = (v: number): number => Math.round(v * 1e9) / 1e9 + 0

describe('readDxf', () => {
  it('reads LINE, CIRCLE, ARC and POINT on their layers, with nothing to undo', () => {
    const d = readDxf(file(
      [
        0, 'LINE', 5, '2A', 8, 'Walls', 62, 1, 10, 1, 20, 2, 30, 0, 11, 4, 21, 6, 31, 0,
        0, 'CIRCLE', 5, '2B', 8, '0', 10, 5, 20, 5, 30, 0, 40, 2.5,
        0, 'ARC', 5, '2C', 8, '0', 10, 0, 20, 0, 40, 3, 50, 90, 51, 180,
        0, 'POINT', 5, '2D', 8, 'Walls', 10, 7, 20, 8,
      ],
      LAYER_TABLE([2, '0', 70, 0, 62, 7], [2, 'Walls', 70, 0, 62, 3]),
    ))
    const walls = d.doc.layers.indexOf('Walls')
    expect(d.doc.layers.get(walls)).toEqual({ name: 'Walls', color: 3, visible: true, locked: false })
    const [line, circle, arc, point] = all(d) as [Line, Circle, Arc, Point]
    expect(line).toEqual({ type: 'line', id: 1, layer: walls, color: 1, x0: 1, y0: 2, x1: 4, y1: 6 })
    expect(circle).toEqual({ type: 'circle', id: 2, layer: 0, cx: 5, cy: 5, r: 2.5 })
    expect([arc.cx, arc.cy, arc.r, r9(arc.a0), r9(arc.a1)]).toEqual([0, 0, 3, r9(Math.PI / 2), r9(Math.PI)])
    expect(point).toEqual({ type: 'point', id: 4, layer: walls, x: 7, y: 8 })
    expect(d.doc.undo()).toBeUndefined()
    expect(d.warnings).toEqual([])
  })

  it('LWPOLYLINE: vertices, bulges, the closed flag; POLYLINE with its VERTEX and SEQEND is one polyline', () => {
    const d = readDxf(file([
      0, 'LWPOLYLINE', 5, '30', 8, '0', 90, 3, 70, 1, 10, 0, 20, 0, 42, 1, 10, 10, 20, 0, 10, 10, 20, 10,
      0, 'POLYLINE', 5, '31', 8, '0', 66, 1, 70, 0, 10, 0, 20, 0, 30, 0,
      0, 'VERTEX', 5, '32', 8, '0', 10, 0, 20, 0, 42, 0.5,
      0, 'VERTEX', 5, '33', 8, '0', 10, 5, 20, 0,
      0, 'VERTEX', 5, '34', 8, '0', 70, 16, 10, 9, 20, 9, // a spline frame point: not on the curve
      0, 'SEQEND', 5, '35', 8, '0',
      0, 'LINE', 5, '36', 8, '0', 10, 0, 20, 0, 11, 1, 21, 1,
    ]))
    const [lw, old, line] = all(d) as [Polyline, Polyline, Line]
    expect([Array.from(lw.pts), Array.from(lw.bulges!), lw.closed]).toEqual([[0, 0, 10, 0, 10, 10], [1, 0, 0], true])
    expect([Array.from(old.pts), Array.from(old.bulges!), old.closed]).toEqual([[0, 0, 5, 0], [0.5, 0], false])
    expect(line.type).toBe('line')
    const span = d.source.loaded(old.id)!
    const text = d.source.text.slice(span.start, span.end)
    expect(text.startsWith('  0\r\nPOLYLINE\r\n')).toBe(true)
    expect(text.endsWith('SEQEND\r\n  5\r\n35\r\n  8\r\n0\r\n')).toBe(true)
  })

  it('extrusion (0,0,-1) mirrors across the Y axis; any other direction is kept as is', () => {
    const d = readDxf(file([
      0, 'CIRCLE', 8, '0', 10, 5, 20, 1, 40, 1, 210, 0, 220, 0, 230, -1,
      0, 'ARC', 8, '0', 10, 2, 20, 0, 40, 1, 50, 0, 51, 90, 210, 0, 220, 0, 230, -1,
      0, 'LWPOLYLINE', 8, '0', 90, 2, 70, 0, 10, 1, 20, 0, 42, 0.5, 10, 3, 20, 0, 210, 0, 220, 0, 230, -1,
      0, 'CIRCLE', 8, '0', 10, 5, 20, 1, 40, 1, 210, 1, 220, 0, 230, 0,
    ]))
    const [c, a, p, tilted] = all(d) as [Circle, Arc, Polyline, Opaque]
    expect([c.cx, c.cy]).toEqual([-5, 1])
    // The quarter from OCS 0° to 90° runs, seen from +Z, from 90° to 180°.
    expect([a.cx, r9(a.a0), r9(a.a1)]).toEqual([-2, r9(Math.PI / 2), r9(Math.PI)])
    expect([Array.from(p.pts), Array.from(p.bulges!)]).toEqual([[-1, 0, -3, 0], [-0.5, -0]])
    expect(tilted).toMatchObject({ type: 'opaque', name: 'CIRCLE' })
    expect(d.warnings).toEqual(['line 85: CIRCLE kept as is: extrusion (1, 0, 0) is not supported.'])
  })

  it('keeps what it does not understand as is, with its exact text: HATCH, INSERT and its attributes, paper space', () => {
    const hatch: G = [0, 'HATCH', 5, '40', 8, 'Hatch', 62, 2, 10, 0, 20, 0, 30, 0, 2, 'SOLID', 70, 1]
    const insert: G = [0, 'INSERT', 5, '41', 8, '0', 66, 1, 2, 'DOOR', 10, 1, 20, 1, 0, 'ATTRIB', 5, '42', 8, '0', 1, 'D1', 2, 'TAG', 0, 'SEQEND', 5, '43', 8, '0']
    const paper: G = [0, 'LINE', 5, '44', 8, '0', 67, 1, 10, 0, 20, 0, 11, 1, 21, 1]
    const d = readDxf(file([...hatch, ...insert, ...paper]))
    const [h, ins, p] = all(d) as [Opaque, Opaque, Opaque]
    expect(h).toMatchObject({ type: 'opaque', name: 'HATCH', color: 2, raw: lines(hatch), layer: d.doc.layers.indexOf('Hatch') })
    expect(ins).toMatchObject({ type: 'opaque', name: 'INSERT', raw: lines(insert) })
    expect(p).toMatchObject({ type: 'opaque', name: 'LINE', raw: lines(paper) })
    expect(d.warnings).toEqual(['line 43: INSERT kept as is: block DOOR is not defined.', '1 HATCH kept as is (not drawn).', '1 entity in paper space kept as is (not drawn).'])
  })

  it('invisible entities (60 = 1) are kept as is, not drawn, in model space and in blocks', () => {
    const line: G = [0, 'LINE', 8, '0', 60, 1, 10, 0, 20, 0, 11, 1, 21, 1]
    const circle: G = [0, 'CIRCLE', 8, '0', 60, 1, 10, 0, 20, 0, 40, 1]
    const shown: G = [0, 'LINE', 8, '0', 60, 0, 10, 0, 20, 0, 11, 1, 21, 1]
    const insert: G = [0, 'INSERT', 8, '0', 2, 'B', 10, 0, 20, 0]
    const d = readDxf(lines([
      0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 8, '0', 2, 'B', 70, 0, 10, 0, 20, 0, ...circle, ...shown, 0, 'ENDBLK', 0, 'ENDSEC',
      0, 'SECTION', 2, 'ENTITIES', ...line, ...circle, ...shown, ...insert, 0, 'ENDSEC', 0, 'EOF',
    ]))
    const [l, c, s, i] = all(d) as [Opaque, Opaque, Line, Insert]
    expect(l).toMatchObject({ type: 'opaque', name: 'LINE', raw: lines(line) })
    expect(c).toMatchObject({ type: 'opaque', name: 'CIRCLE', raw: lines(circle) })
    expect(s.type).toBe('line')
    expect(i.block.entities.map((e) => e.type)).toEqual(['line'])
    expect(d.warnings).toEqual(['2 invisible entities kept as is (not drawn).', '1 entity in blocks not drawn.'])
  })

  it('ELLIPSE: in WCS; an extrusion of (0, 0, -1) runs it the other way; 0 to 2π is the whole ellipse', () => {
    const e: G = [0, 'ELLIPSE', 8, '0', 10, 10, 20, 20, 30, 0, 11, 6, 21, 8, 31, 0, 40, 0.5, 41, 0.5, 42, 4]
    const mirrored: G = [...e, 210, 0, 220, 0, 230, -1]
    const whole: G = [0, 'ELLIPSE', 8, '0', 10, 0, 20, 0, 11, 5, 21, 0, 40, 0.3, 41, 0, 42, 6.283185307179586]
    const tilted: G = [...e, 210, 1, 220, 0, 230, 0]
    const d = readDxf(file([...e, ...mirrored, ...whole, ...tilted]))
    const [a, m, w, t] = all(d) as [Ellipse, Ellipse, Ellipse, Opaque]
    expect(a).toMatchObject({ type: 'ellipse', cx: 10, cy: 20, mx: 6, my: 8, ratio: 0.5, t0: 0.5, t1: 4 })
    // ezdxf puts the start of the mirrored one at (17.183…, 25.582…): the end of ours, which runs counter-clockwise.
    expect(m).toMatchObject({ type: 'ellipse', cx: 10, cy: 20, mx: 6, my: 8, ratio: 0.5 })
    expect(r9(m.t0)).toBe(r9(2 * Math.PI - 4))
    expect(r9(m.t1)).toBe(r9(2 * Math.PI - 0.5))
    expect(w.t0).toBe(w.t1)
    expect(t.type).toBe('opaque')
    expect(d.warnings).toHaveLength(1)
  })

  it('SPLINE: degree, knots, control points, weights and the closed flag; 3D, fit points only and bad data stay as is', () => {
    const knots = [0, 0, 0, 0, 1, 1, 1, 1].flatMap((k) => [40, k])
    const ctrl = [[0, 0], [1, 2], [3, 2], [4, 0]].flatMap(([x, y]) => [10, x!, 20, y!, 30, 0])
    const plain: G = [0, 'SPLINE', 8, '0', 100, 'AcDbSpline', 70, 8, 71, 3, 72, 8, 73, 4, 74, 0, ...knots, ...ctrl]
    const rational: G = [0, 'SPLINE', 8, '0', 70, 13, 71, 3, 72, 8, 73, 4, 74, 0, ...knots, 41, 1, 41, 2, 41, 2, 41, 1, ...ctrl]
    const lifted: G = [0, 'SPLINE', 8, '0', 70, 8, 71, 3, 72, 8, 73, 4, ...knots, ...ctrl.map((v, i) => (i === 11 ? 5 : v))]
    const fitted: G = [0, 'SPLINE', 8, '0', 70, 8, 71, 3, 72, 0, 73, 0, 74, 2, 11, 0, 21, 0, 31, 0, 11, 1, 21, 1, 31, 0]
    const bad: G = [0, 'SPLINE', 8, '0', 70, 8, 71, 3, 72, 7, 73, 4, ...knots.slice(2), ...ctrl]
    const d = readDxf(file([...plain, ...rational, ...lifted, ...fitted, ...bad]))
    const [p, r, l, f, b] = all(d) as [Spline, Spline, Opaque, Opaque, Opaque]
    expect(p).toMatchObject({ type: 'spline', degree: 3, closed: false, weights: null })
    expect([...p.knots]).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
    expect([...p.ctrl]).toEqual([0, 0, 1, 2, 3, 2, 4, 0])
    expect(r).toMatchObject({ type: 'spline', closed: true })
    expect([...r.weights!]).toEqual([1, 2, 2, 1])
    expect([l.type, f.type, b.type]).toEqual(['opaque', 'opaque', 'opaque'])
    expect(d.warnings).toHaveLength(3)
    expect(d.warnings.join(' ')).toMatch(/3D/)
    expect(d.warnings.join(' ')).toMatch(/fit points/)
    expect(d.warnings.join(' ')).toMatch(/knots/)
  })

  it('BLOCK and INSERT: nested blocks with their base points, layer 0 and ByBlock kept for the insert, -Z, grids', () => {
    const blocks: G = [
      0, 'BLOCK', 8, '0', 2, 'A', 70, 0, 10, 1, 20, 1, 30, 0, 3, 'A',
      0, 'LINE', 8, '0', 62, 0, 10, 1, 20, 1, 11, 3, 21, 1,
      0, 'CIRCLE', 8, 'Walls', 62, 3, 10, 2, 20, 2, 40, 1,
      0, 'HATCH', 8, '0', 2, 'SOLID',
      0, 'ENDBLK', 8, '0',
      0, 'BLOCK', 8, '0', 2, 'b', 70, 0, 10, 0, 20, 0,
      0, 'INSERT', 8, '0', 62, 0, 2, 'a', 10, 10, 20, 0, 41, 2, 42, 2, 50, 90,
      0, 'LINE', 8, 'Doors', 10, 0, 20, 0, 11, 0, 21, 5,
      0, 'ENDBLK',
      0, 'BLOCK', 8, '0', 2, 'LOOP', 70, 0, 10, 0, 20, 0,
      0, 'INSERT', 8, '0', 2, 'LOOP', 10, 0, 20, 0,
      0, 'ENDBLK',
      0, 'BLOCK', 8, '0', 2, 'X', 70, 4, 10, 0, 20, 0, 1, 'other.dwg',
      0, 'ENDBLK',
    ]
    const entities: G = [
      0, 'INSERT', 8, 'Plan', 62, 6, 2, 'B', 10, 100, 20, 50, 41, 0.5, 42, 0.5, 50, 30,
      0, 'INSERT', 8, '0', 2, 'A', 10, 10, 20, 20, 50, 30, 210, 0, 220, 0, 230, -1,
      0, 'INSERT', 8, '0', 2, 'A', 10, 0, 20, 0, 70, 2, 71, 3, 44, 10, 45, 20,
      0, 'INSERT', 8, '0', 2, 'LOOP', 10, 0, 20, 0,
      0, 'INSERT', 8, '0', 2, 'NOPE', 10, 0, 20, 0,
      0, 'INSERT', 8, '0', 2, 'X', 10, 0, 20, 0,
    ]
    const text = lines([
      0, 'SECTION', 2, 'BLOCKS', ...blocks, 0, 'ENDSEC',
      0, 'SECTION', 2, 'ENTITIES', ...entities, 0, 'ENDSEC', 0, 'EOF',
    ])
    const d = readDxf(text)
    const [b, mirrored, grid, ...kept] = all(d) as [Insert, Insert, Insert, Opaque, Opaque, Opaque]
    const L = (name: string): number => d.doc.layers.indexOf(name)
    expect(b).toMatchObject({ type: 'insert', layer: L('Plan'), color: 6, x: 100, y: 50, sx: 0.5, sy: 0.5, cols: 1, rows: 1 })
    expect(b.rotation).toBeCloseTo(Math.PI / 6, 12)
    expect(b.block).toMatchObject({ name: 'b', x: 0, y: 0 })
    const [nested, door] = b.block.entities as [Omit<Insert, 'id'>, Omit<Line, 'id'>]
    expect(nested).toMatchObject({ type: 'insert', layer: 0, color: BY_BLOCK, x: 10, y: 0, sx: 2, sy: 2 })
    expect(door).toMatchObject({ type: 'line', layer: L('Doors'), x1: 0, y1: 5 })
    // A: its base, a ByBlock line on layer 0, a circle; the HATCH is not drawn.
    expect(nested.block).toMatchObject({ name: 'A', x: 1, y: 1 })
    expect(nested.block.entities).toEqual([
      { type: 'line', layer: 0, color: BY_BLOCK, x0: 1, y0: 1, x1: 3, y1: 1 },
      { type: 'circle', layer: L('Walls'), color: 3, cx: 2, cy: 2, r: 1 },
    ])
    // The same block, read once.
    expect(mirrored.block).toBe(nested.block)
    // Seen from -Z: x mirrored, the turn and the X scale reversed.
    expect(mirrored).toMatchObject({ x: -10, y: 20, sx: -1, sy: 1 })
    expect(mirrored.rotation).toBeCloseTo(2 * Math.PI - Math.PI / 6, 12)
    expect(grid).toMatchObject({ cols: 2, rows: 3, dx: 10, dy: 20 })
    expect(kept.map((k) => k.type)).toEqual(['opaque', 'opaque', 'opaque'])
    expect(d.warnings.join(' ')).toMatch(/LOOP/)
    expect(d.warnings.join(' ')).toMatch(/NOPE/)
    expect(d.warnings.join(' ')).toMatch(/external/)
  })

  it('numbers whose geometry a double cannot hold keep the entity as is, with a warning; the rest opens', () => {
    const huge: G = [0, 'CIRCLE', 8, '0', 10, 1e308, 20, 0, 40, 1e308]
    const blocks: G = [0, 'BLOCK', 8, '0', 2, 'B', 70, 0, 10, 0, 20, 0, 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 1e10, 21, 0, ...huge, 0, 'ENDBLK']
    const entities: G = [
      ...huge,
      0, 'LWPOLYLINE', 8, '0', 90, 2, 70, 0, 10, 0, 20, 0, 42, 1e300, 10, 1, 20, 0,
      0, 'ELLIPSE', 8, '0', 10, 1e308, 20, 0, 11, 1e308, 21, 0, 40, 1,
      0, 'INSERT', 8, '0', 2, 'B', 10, 0, 20, 0, 41, 1e300, 42, 1e300,
      0, 'INSERT', 8, '0', 2, 'B', 10, 0, 20, 0, 41, 0,
      0, 'INSERT', 8, '0', 2, 'B', 10, 0, 20, 0,
    ]
    const d = readDxf(lines([0, 'SECTION', 2, 'BLOCKS', ...blocks, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', ...entities, 0, 'ENDSEC', 0, 'EOF']))
    const list = all(d)
    expect(list.map((e) => e.type)).toEqual(['opaque', 'opaque', 'opaque', 'opaque', 'opaque', 'insert'])
    // The block keeps its line; its circle is not drawn.
    expect((list[5] as Insert).block.entities.map((e) => e.type)).toEqual(['line'])
    expect(d.warnings).toEqual([
      'line 47: CIRCLE kept as is: its geometry overflows.',
      'line 57: LWPOLYLINE kept as is: its geometry overflows.',
      'line 75: ELLIPSE kept as is: its geometry overflows.',
      'line 89: INSERT kept as is: its geometry overflows.',
      'line 103: INSERT kept as is: insert scale must not be zero, got 0, 1.',
      '1 entity in blocks not drawn.',
    ])
  })

  it('a spline whose flattening would pass the largest double is kept as is: wide control points, heavy weights', () => {
    const knots = [0, 0, 0, 0, 1, 1, 1, 1].flatMap((k) => [40, k])
    const spline = (pts: number[][], weights: number[] = []): G => [
      0, 'SPLINE', 8, '0', 70, weights.length > 0 ? 12 : 8, 71, 3, 72, 8, 73, 4, ...knots, ...weights.flatMap((w) => [41, w]), ...pts.flatMap(([x, y]) => [10, x!, 20, y!, 30, 0]),
    ]
    const wide = spline([[0, 0], [1e308, 0], [-1e308, 0], [0, 1]])
    // 1e10 × 1e300 is past the largest double: flattening it never ends.
    const heavy = spline([[0, 0], [1e10, 1e10], [2e10, 0], [3e10, 1e10]], [1, 1e300, 1e300, 1])
    const fine = spline([[0, 0], [1e10, 1e10], [2e10, 0], [3e10, 1e10]], [1, 2, 2, 1])
    const d = readDxf(file([...wide, ...heavy, ...fine]))
    expect(all(d).map((e) => e.type)).toEqual(['opaque', 'opaque', 'spline'])
    expect(d.warnings).toEqual(['line 25: SPLINE kept as is: its geometry overflows.', 'line 77: SPLINE kept as is: its geometry overflows.'])
  })

  it('layers: color, off, frozen, locked and true color from the table; an unknown layer is created', () => {
    const d = readDxf(file(
      [0, 'LINE', 8, 'Nowhere', 10, 0, 20, 0, 11, 1, 21, 1],
      LAYER_TABLE([2, '0', 70, 0, 62, 5], [2, 'Off', 70, 0, 62, -2], [2, 'Frozen', 70, 1, 62, 3], [2, 'Locked', 70, 4, 62, 4], [2, 'True', 70, 0, 62, 5, 420, 0x123456]),
    ))
    const layer = (name: string) => d.doc.layers.get(d.doc.layers.indexOf(name))
    expect(layer('0')).toEqual({ name: '0', color: 5, visible: true, locked: false })
    expect(layer('Off')).toMatchObject({ color: 2, visible: false })
    expect(layer('Frozen')).toMatchObject({ color: 3, visible: false })
    expect(layer('Locked')).toMatchObject({ color: 4, visible: true, locked: true })
    expect(layer('True')!.color).toBe(TRUE_COLOR | 0x123456)
    expect(layer('Nowhere')).toEqual({ name: 'Nowhere', color: 7, visible: true, locked: false })
    expect(all(d)[0]!.layer).toBe(d.doc.layers.indexOf('Nowhere'))
  })

  it('999 comments after 0/SECTION and 0/TABLE: the LAYER table is read, the section spans its 0/SECTION', () => {
    const tables: G = [0, 'SECTION', 999, 'tables', 2, 'TABLES', 0, 'TABLE', 999, 'layer table', 2, 'LAYER', 70, 1, 0, 'LAYER', 2, 'Off', 70, 0, 62, -2, 0, 'ENDTAB', 0, 'ENDSEC']
    const d = readDxf(lines([...tables, 0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, 'Off', 10, 0, 20, 0, 11, 1, 21, 1, 0, 'ENDSEC', 0, 'EOF']))
    expect(d.doc.layers.get(d.doc.layers.indexOf('Off'))).toEqual({ name: 'Off', color: 2, visible: false, locked: false })
    const s = d.source.sections[0]!
    expect(s.name).toBe('TABLES')
    expect(d.source.text.slice(s.start, s.end)).toBe(lines(tables))
  })

  it('colors: 256 is ByLayer, ByBlock (0) shows white, 420 true color wins over 62', () => {
    const line = (...extra: G): G => [0, 'LINE', 8, '0', ...extra, 10, 0, 20, 0, 11, 1, 21, 1]
    const d = readDxf(file([...line(62, 256), ...line(62, 0), ...line(62, 1, 420, 0x00ff80), ...line()]))
    expect(all(d).map((e) => e.color)).toEqual([undefined, 7, TRUE_COLOR | 0x00ff80, undefined])
  })

  it('keeps the text, handles and header the writer needs', () => {
    const d = readDxf(file([0, 'LINE', 5, '2A', 8, '0', 10, 0, 20, 0, 11, 1, 21, 1, 0, 'HATCH', 5, '2B', 8, '0']))
    const [line, hatch] = all(d)
    expect(d.source.newline).toBe('\r\n')
    expect(d.source.header.get('$ACADVER')).toBe('AC1015')
    expect(d.source.header.get('$HANDSEED')).toBe('FF')
    expect(d.source.handseed).toBe(0xff)
    // A $HANDSEED left behind by its writer: the next handle is past the largest in the file.
    expect(readDxf(file([0, 'LINE', 5, '1A0', 8, '0', 10, 0, 20, 0, 11, 1, 21, 1])).source.handseed).toBe(0x1a1)
    expect(d.source.sections.map((s) => s.name)).toEqual(['HEADER', 'TABLES', 'ENTITIES'])
    const tables = d.source.sections[1]!
    expect(d.source.text.slice(tables.start, tables.end)).toBe(lines([0, 'SECTION', 2, 'TABLES', 0, 'ENDSEC']))
    expect(d.source.handleOf(line!.id)).toBe('2A')
    expect(d.source.handleOf(hatch!.id)).toBe('2B')
    expect(d.source.handleOf(99)).toBeNull()
    expect(d.source.loaded(line!.id)!.entity).toBe(line)
    d.doc.transact('edit', (tx) => tx.replace({ ...(line as Line), x1: 5 }))
    expect(d.source.loaded(line!.id)!.entity).not.toBe(d.doc.get(line!.id))
  })

  it('a bad number keeps the entity as is, with a warning that names the line', () => {
    const d = readDxf(file([0, 'LINE', 8, '0', 10, 'abc', 20, 0, 11, 1, 21, 1]))
    expect(all(d)[0]).toMatchObject({ type: 'opaque', name: 'LINE' })
    expect(d.warnings).toEqual(['line 30: LINE kept as is: invalid number "abc".'])
  })

  it('reads an R12 file without tables or handles; LF line ends are kept', () => {
    const text = lines([0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, 'A', 10, 0, 20, 0, 11, 1, 21, 1, 0, 'ENDSEC', 0, 'EOF']).replace(/\r\n/g, '\n')
    const d = readDxf(text)
    expect(all(d)).toHaveLength(1)
    expect(d.source.newline).toBe('\n')
    expect(d.source.handleOf(1)).toBeNull()
    expect(readDxf(lines([0, 'EOF'])).doc.size).toBe(0)
  })

  it('parses to plain data a worker can post, then loads it into an existing document', () => {
    const text = file([0, 'LINE', 5, '2A', 8, 'Walls', 10, 0, 20, 0, 11, 1, 21, 1, 0, 'HATCH', 5, '2B', 8, '0'], LAYER_TABLE([2, 'Walls', 70, 0, 62, 3]))
    const seen: number[] = []
    const parsed = structuredClone(parseDxf(text, (f) => seen.push(f)))
    expect(seen.at(-1)).toBe(1)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    const doc = createDocument()
    doc.transact('old', (tx) => void tx.add({ type: 'circle', layer: 0, cx: 0, cy: 0, r: 1 }))
    const d = drawingFrom(doc, parsed)
    expect(d.doc).toBe(doc)
    expect([...doc.entities()].map((e) => e.type)).toEqual(['line', 'opaque'])
    expect(d.source.handleOf(2)).toBe('2A')
    expect(doc.layers.get(1)!.name).toBe('Walls')
    expect(doc.undo()).toBeUndefined()
  })

  it('drawingFrom is all or nothing: a bad draft leaves the drawing as it was', () => {
    const parsed = parseDxf(file([0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 1, 21, 1]))
    const doc = createDocument()
    doc.transact('old', (tx) => void tx.add({ type: 'circle', layer: 0, cx: 0, cy: 0, r: 1 }))
    expect(() => drawingFrom(doc, { ...parsed, drafts: [...parsed.drafts, { type: 'circle', layer: 0, cx: 0, cy: 0, r: 0 }] })).toThrow()
    expect([...doc.entities()].map((e) => e.type)).toEqual(['circle'])
  })

  it('loads in slices; an entity added between them has no source, and the others keep theirs', () => {
    const parsed = parseDxf(file([0, 'LINE', 5, '2A', 8, '0', 10, 0, 20, 0, 11, 1, 21, 1, 0, 'LINE', 5, '2B', 8, '0', 10, 2, 20, 2, 11, 3, 21, 3]))
    const doc = createDocument()
    const l = loader(doc, parsed)
    l.add(parsed.drafts.slice(0, 1))
    doc.transact('meanwhile', (tx) => void tx.add({ type: 'circle', layer: 0, cx: 0, cy: 0, r: 1 }))
    l.add(parsed.drafts.slice(1))
    const d = l.finish()
    expect([...doc.entities()].map((e) => d.source.handleOf(e.id))).toEqual(['2A', null, '2B'])
  })
})
