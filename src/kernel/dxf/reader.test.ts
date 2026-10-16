import { describe, expect, it } from 'vitest'
import { TRUE_COLOR } from '../color'
import type { Arc, Circle, Entity, Line, Opaque, Point, Polyline } from '../entity/types'
import { readDxf } from './reader'

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
    expect(d.warnings).toEqual(['1 HATCH kept as is (not drawn).', '1 INSERT kept as is (not drawn).', '1 entity in paper space kept as is (not drawn).'])
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
})
