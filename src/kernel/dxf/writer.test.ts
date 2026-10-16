import { describe, expect, it } from 'vitest'
import { TRUE_COLOR } from '../color'
import { createDocument, type Document } from '../document'
import { BY_BLOCK, type Arc, type Circle, type Ellipse, type Entity, type Insert, type Line, type MText, type Polyline, type Spline, type Text } from '../entity/types'
import { typeOf } from '../entity/registry'
import { rotation } from '../geom/vec'
import { commandBench } from '../command/testing'
import { drawingFrom, parseDxf, readDxf } from './reader'
import { tokenize } from './tokenizer'
import { nearestAci, real, writeDxf } from './writer'

type G = (string | number)[]

const lines = (gs: G, nl = '\r\n'): string => {
  const out: string[] = []
  for (let i = 0; i < gs.length; i += 2) out.push(String(gs[i]).padStart(3, ' '), String(gs[i + 1]))
  return out.map((l) => l + nl).join('')
}

const LAYERS: G = [
  0, 'TABLE', 2, 'LAYER', 5, '2', 330, '0', 100, 'AcDbSymbolTable', 70, 2,
  0, 'LAYER', 5, '10', 330, '2', 100, 'AcDbSymbolTableRecord', 100, 'AcDbLayerTableRecord', 2, '0', 70, 0, 62, 7, 6, 'Continuous', 390, 'F',
  0, 'LAYER', 5, '11', 330, '2', 100, 'AcDbSymbolTableRecord', 100, 'AcDbLayerTableRecord', 2, 'Walls', 70, 0, 62, 3, 6, 'Continuous', 390, 'F',
  0, 'ENDTAB',
  0, 'TABLE', 2, 'BLOCK_RECORD', 5, '1', 330, '0', 100, 'AcDbSymbolTable', 70, 1,
  0, 'BLOCK_RECORD', 5, '1F', 330, '1', 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord', 2, '*Model_Space',
  0, 'ENDTAB',
]

/** An AC1015-like file: HEADER, TABLES (LAYER, BLOCK_RECORD), ENTITIES, OBJECTS. */
function file(entities: G, version = 'AC1015', seed = '100', objects: G = [0, 'DICTIONARY', 5, 'C', 330, '0', 100, 'AcDbDictionary']): string {
  return lines([
    0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, version, 9, '$HANDSEED', 5, seed, 0, 'ENDSEC',
    0, 'SECTION', 2, 'TABLES', ...LAYERS, 0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES', ...entities, 0, 'ENDSEC',
    0, 'SECTION', 2, 'OBJECTS', ...objects, 0, 'ENDSEC',
    0, 'EOF',
  ])
}

const LINE: G = [0, 'LINE', 5, '20', 330, '1F', 100, 'AcDbEntity', 8, 'Walls', 6, 'DASHED', 370, 25, 100, 'AcDbLine', 10, 0, 20, 0, 30, 0, 11, 10, 21, 0, 31, 0, 1001, 'ROYALE', 1000, 'kept']
const CIRCLE: G = [0, 'CIRCLE', 5, '21', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbCircle', 10, 5, 20, 1, 30, 0, 40, 1, 210, 0, 220, 0, 230, -1]
const HATCH: G = [0, 'HATCH', 5, '22', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbHatch', 10, 0, 20, 0, 30, 0, 2, 'SOLID']
const LWPOLY: G = [0, 'LWPOLYLINE', 5, '23', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbPolyline', 90, 2, 70, 0, 43, 0, 10, 0, 20, 0, 10, 4, 20, 0, 210, 0, 220, 0, 230, 1]

/** An R12 file with handles: HEADER, a LAYER table of the entries given, ENTITIES. */
function r12(layers: G[], entities: G, header: G = []): string {
  return lines([
    0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$HANDLING', 70, 1, 9, '$HANDSEED', 5, '100', ...header, 0, 'ENDSEC',
    0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, layers.length, ...layers.flatMap((e) => [0, 'LAYER', ...e]), 0, 'ENDTAB', 0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES', ...entities, 0, 'ENDSEC',
    0, 'EOF',
  ])
}

/** The document's layer names, in order. */
const layerNames = ({ doc }: { doc: Document }): string[] => Array.from({ length: doc.layers.size }, (_, i) => doc.layers.get(i)!.name)

/** An R12 file with only these entities; with $HANDLING 1 unless told otherwise. */
const r12Only = (entities: G, handling = true): string =>
  lines([
    0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', ...(handling ? [9, '$HANDLING', 70, 1, 9, '$HANDSEED', 5, '100'] : []), 0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES', ...entities, 0, 'ENDSEC', 0, 'EOF',
  ])

/**
 * A dashed 2D POLYLINE as ezdxf writes it, moved by (dx, dy): default widths 0.2, one vertex with a start width of
 * its own; R13 or R12.
 */
function oldPolyline(modern: boolean, dx = 0, dy = 0): G {
  const m = (...g: G): G => (modern ? g : [])
  const vertex = (handle: string, x: number, ...own: G): G => [
    0, 'VERTEX', 5, handle, ...m(330, '2D', 100, 'AcDbEntity'), 8, '0', ...m(100, 'AcDbVertex', 100, 'AcDb2dVertex'), 10, real(x + dx), 20, real(dy), 30, '0.0', ...own, 70, 0,
  ]
  return [
    0, 'POLYLINE', 5, '2D', ...m(330, '1F', 100, 'AcDbEntity'), 8, '0', 6, 'DASHED', ...m(100, 'AcDb2dPolyline'), 66, 1, 10, '0.0', 20, '0.0', 30, '0.0', 70, 0, 40, 0.2, 41, 0.2,
    ...vertex('2F', 0), ...vertex('30', 10, 40, '2.0'), ...vertex('31', 12),
    0, 'SEQEND', 5, '2E', ...m(330, '2D', 100, 'AcDbEntity'), 8, '0',
  ]
}

/** g without its handles (group 5). */
const noHandles = (g: G): G => g.filter((_, i) => !(i % 2 === 0 && g[i] === 5) && !(i % 2 === 1 && g[i - 1] === 5))

/** Each vertex's start and end width, its own or the polyline's default. */
const widthsOf = (p: Polyline): number[] =>
  p.widths ? Array.from(p.widths) : Array.from({ length: p.pts.length }, (_, i) => (i % 2 === 0 ? p.startWidth : p.endWidth) ?? 0)

/** Every handle the text defines (groups 5 and 105 outside the HEADER). */
function handles(text: string): string[] {
  const p = tokenize(text)
  const out: string[] = []
  let inHeader = false
  for (let i = 0; i < p.length; i++) {
    if (p.is(i, 2, 'HEADER')) inHeader = true
    if (p.is(i, 0, 'ENDSEC')) inHeader = false
    if (!inHeader && (p.code(i) === 5 || p.code(i) === 105)) out.push(p.value(i).trim())
  }
  return out
}

/** The entities of the two documents match, ids aside. */
const same = (a: Entity[], b: Entity[]): void => {
  const strip = (es: Entity[]) => es.map(({ id: _id, ...rest }) => rest)
  expect(strip(b)).toEqual(strip(a))
}

describe('real', () => {
  it('writes the shortest digits that read back the same, always with a point', () => {
    expect([5, -0, 0.1, 1 / 3, 1e-7, 1.5e21, -2.5e-12].map(real)).toEqual(['5.0', '0.0', '0.1', '0.3333333333333333', '1.0E-07', '1.5E+21', '-2.5E-12'])
    for (const x of [1 / 3, Math.PI, 7_400_000.123456789, 1e-300]) expect(Number(real(x))).toBe(x)
  })
})

describe('nearestAci', () => {
  it('gives the 62 AutoCAD writes beside a 420: black is 18 (dark red), not a gray, as in its own VISUALSTYLE objects', () => {
    // AutoCAD's visual styles, as ezdxf copies them into a drawing it sets up, pair 420 0 with 62 18, 255 with 5,
    // white with 7: AutoCAD's own nearest index, the hue included.
    expect([0x000000, 0x0000ff, 0xffffff].map(nearestAci)).toEqual([18, 5, 7])
    expect([0x101010, 0x404040, 0x808080].map(nearestAci)).toEqual([250, 250, 8])
  })
})

describe('writeDxf', () => {
  it('a file written back without edits is the file read, byte for byte', () => {
    const text = file([...LINE, ...CIRCLE, ...HATCH, ...LWPOLY])
    const d = readDxf(text)
    expect(writeDxf(d.doc, d.source)).toBe(text)
    // A new current layer goes into the header.
    expect(readDxf(writeDxf(d.doc, d.source, { currentLayer: 'Walls' })).source.header.get('$CLAYER')).toBe('Walls')
  })

  it('text outside the sections, such as the 999 comment LibreCAD starts with, is written back as read', () => {
    const ENTITIES = lines([0, 'SECTION', 2, 'ENTITIES'])
    const text = lines([999, 'dxfrw 0.6.3']) + file(LINE).replace(ENTITIES, lines([999, 'between']) + ENTITIES).replace(lines([0, 'EOF']), lines([999, 'last', 0, 'EOF']))
    const d = readDxf(text)
    expect(writeDxf(d.doc, d.source)).toBe(text)
    d.doc.transact('edit', (tx) => tx.replace({ ...([...d.doc.entities()][0] as Line), x1: 20 }))
    const out = writeDxf(d.doc, d.source)
    expect(out.startsWith(lines([999, 'dxfrw 0.6.3', 0, 'SECTION', 2, 'HEADER']))).toBe(true)
    expect(out).toContain(lines([0, 'ENDSEC', 999, 'between', 0, 'SECTION', 2, 'ENTITIES']))
    expect(out.endsWith(lines([0, 'ENDSEC', 999, 'last', 0, 'EOF']))).toBe(true)
  })

  it('a file with only a HEADER gets its new TABLES after the HEADER', () => {
    const text = lines([0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 0, 'ENDSEC', 0, 'EOF'], '\n')
    const d = readDxf(text)
    const b = d.doc.layers.add({ name: 'B', color: 1, visible: true, locked: false })
    d.doc.transact('draw', (tx) => void tx.add({ type: 'line', layer: b, x0: 0, y0: 0, x1: 1, y1: 1 }))
    const back = readDxf(writeDxf(d.doc, d.source))
    expect(back.source.sections.map((s) => s.name)).toEqual(['HEADER', 'TABLES', 'ENTITIES'])
    expect(back.doc.layers.get(back.doc.layers.indexOf('B'))).toEqual({ name: 'B', color: 1, visible: true, locked: false })
  })

  it('an R12 file without handles: an edit is patched in place too, its extra groups and OCS kept', () => {
    const text = lines([
      0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 0, 'ENDSEC',
      0, 'SECTION', 2, 'ENTITIES',
      0, 'LINE', 8, '0', 6, 'DASHED', 39, 2.5, 10, 0, 20, 0, 30, 0, 11, 10, 21, 0, 31, 0, 1001, 'ROYALE', 1000, 'kept',
      0, 'CIRCLE', 8, '0', 10, 5, 20, 1, 30, 0, 40, 1, 210, 0, 220, 0, 230, -1,
      0, 'ENDSEC', 0, 'EOF',
    ], '\n')
    const t = commandBench()
    const d = drawingFrom(t.doc, parseDxf(text))
    t.run('MOVE⏎ALL⏎⏎0,0⏎3,4⏎')
    const out = writeDxf(t.doc, d.source)
    expect(out).toContain(lines([0, 'LINE', 8, '0', 6, 'DASHED', 39, 2.5, 10, '3.0', 20, '4.0', 30, 0, 11, '13.0', 21, '4.0', 31, 0, 1001, 'ROYALE', 1000, 'kept'], '\n'))
    // Still seen from -Z: the centre, from (-5, 1) to (-2, 5), is (2, 5) in its OCS.
    expect(out).toContain(lines([0, 'CIRCLE', 8, '0', 10, '2.0', 20, '5.0', 30, 0, 40, '1.0', 210, 0, 220, 0, 230, -1], '\n'))
    expect(handles(out)).toEqual([])
  })

  it('LWPOLYLINE widths survive MOVE and grow with SCALE: each vertex its 40/41, the constant width 43', () => {
    const VARYING: G = [0, 'LWPOLYLINE', 5, '23', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbPolyline', 90, 2, 70, 0, 10, 0, 20, 0, 40, 0.5, 41, 1, 10, 10, 20, 0]
    const CONSTANT: G = [0, 'LWPOLYLINE', 5, '24', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbPolyline', 90, 2, 70, 0, 43, 0.3, 10, 0, 20, 5, 10, 10, 20, 5]
    const t = commandBench()
    const d = drawingFrom(t.doc, parseDxf(file([...VARYING, ...CONSTANT])))
    t.run('MOVE⏎ALL⏎⏎0,0⏎3,4⏎')
    const moved = writeDxf(t.doc, d.source)
    expect(moved).toContain(lines([90, 2, 70, 0, 10, '3.0', 20, '4.0', 40, 0.5, 41, '1.0', 10, '13.0', 20, '4.0', 0, 'LWPOLYLINE']))
    expect(moved).toContain(lines([43, 0.3, 10, '3.0', 20, '9.0', 10, '13.0', 20, '9.0', 0, 'ENDSEC']))
    t.run('SCALE⏎ALL⏎⏎0,0⏎2⏎')
    const scaled = writeDxf(t.doc, d.source)
    expect(scaled).toContain(lines([10, '6.0', 20, '8.0', 40, '1.0', 41, '2.0', 10, '26.0', 20, '8.0', 0, 'LWPOLYLINE']))
    expect(scaled).toContain(lines([43, 0.6, 10, '6.0', 20, '18.0']))
    expect(readDxf(scaled).warnings).toEqual(['2 polylines with width drawn thin (their widths are kept).'])
  })

  it('widths of LWPOLYLINE and 2D POLYLINE (R12, R2000, R2018) are kept through MOVE and scaled by SCALE', () => {
    const LW: G = [0, 'LWPOLYLINE', 5, '23', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbPolyline', 90, 3, 70, 0, 10, 0, 20, 0, 40, 0.5, 41, 0.5, 10, 10, 20, 0, 40, 2, 41, 0, 10, 12, 20, 0]
    const cases: [string, number[]][] = [
      [file(LW), [0.5, 0.5, 2, 0, 0, 0]],
      [r12Only(oldPolyline(false)), [0.2, 0.2, 2, 0.2, 0.2, 0.2]],
      [file(oldPolyline(true)), [0.2, 0.2, 2, 0.2, 0.2, 0.2]],
      [file(oldPolyline(true), 'AC1032'), [0.2, 0.2, 2, 0.2, 0.2, 0.2]],
    ]
    for (const [text, widths] of cases) {
      const t = commandBench()
      const d = drawingFrom(t.doc, parseDxf(text))
      const saved = (): Polyline => [...readDxf(writeDxf(t.doc, d.source)).doc.entities()][0] as Polyline
      t.run('MOVE⏎ALL⏎⏎0,0⏎3,4⏎')
      expect(widthsOf(saved())).toEqual(widths)
      t.run('SCALE⏎ALL⏎⏎0,0⏎2⏎')
      expect(widthsOf(saved())).toEqual(widths.map((w) => 2 * w))
    }
  })

  it('an edited 2D POLYLINE is patched (R12 and R2000): its head as read, its VERTEX handles and SEQEND kept', () => {
    for (const [text, modern] of [[r12Only(oldPolyline(false)), false], [file(oldPolyline(true)), true]] as const) {
      const t = commandBench()
      const d = drawingFrom(t.doc, parseDxf(text))
      t.run('MOVE⏎ALL⏎⏎0,0⏎3,4⏎')
      const out = writeDxf(t.doc, d.source)
      // Linetype, widths, owner and handles as they were; only the vertices moved.
      expect(out).toContain(lines(oldPolyline(modern, 3, 4)))
      expect(readDxf(out).source.header.get('$HANDSEED')).toBe('100')
    }
    // Fewer or more vertices: the old handles while they last, new ones past them; the closed flag follows.
    const d = readDxf(file(oldPolyline(true)))
    const { widths: _w, ...poly } = [...d.doc.entities()][0] as Polyline
    d.doc.transact('edit', (tx) => tx.replace({ ...poly, pts: Float64Array.of(0, 0, 10, 0, 10, 10, 0, 10), bulges: null, closed: true }))
    const more = writeDxf(d.doc, d.source)
    expect(handles(more).filter((h) => !['2', '10', '11', '1', '1F', 'C'].includes(h))).toEqual(['2D', '2F', '30', '31', '100', '2E'])
    expect(more).toContain(lines([66, 1, 10, '0.0', 20, '0.0', 30, '0.0', 70, 1, 40, 0.2, 41, 0.2, 0, 'VERTEX']))
    d.doc.transact('edit', (tx) => tx.replace({ ...poly, pts: Float64Array.of(0, 0, 10, 0), bulges: null }))
    const fewer = writeDxf(d.doc, d.source)
    expect(handles(fewer).filter((h) => !['2', '10', '11', '1', '1F', 'C'].includes(h))).toEqual(['2D', '2F', '30', '2E'])
    same([...d.doc.entities()], [...readDxf(fewer).doc.entities()])
    // An R12 file without handles gets none.
    const t = commandBench()
    const bare = drawingFrom(t.doc, parseDxf(r12Only(noHandles(oldPolyline(false)), false)))
    t.run('MOVE⏎ALL⏎⏎0,0⏎3,4⏎')
    expect(writeDxf(t.doc, bare.source)).toContain(lines(noHandles(oldPolyline(false, 3, 4))))
    // Seen from -Z, its vertices and bulges stay in its OCS.
    const m = commandBench()
    const flipped = drawingFrom(m.doc, parseDxf(file(oldPolyline(true)).replace(lines([41, 0.2]), lines([41, 0.2, 210, 0, 220, 0, 230, -1]))))
    m.doc.transact('bulge', (tx) => tx.replace({ ...([...m.doc.entities()][0] as Polyline), bulges: Float64Array.of(0.5, 0, 0) }))
    m.run('MOVE⏎ALL⏎⏎0,0⏎3,4⏎')
    const back = readDxf(writeDxf(m.doc, flipped.source))
    const [want, got] = [[...m.doc.entities()][0], [...back.doc.entities()][0]] as [Polyline, Polyline]
    expect([Array.from(got.pts), Array.from(got.bulges!, (b) => b + 0), widthsOf(got)]).toEqual([Array.from(want.pts), [0.5, 0, 0], widthsOf(want)])
    expect(back.source.text).toContain(lines([10, '-3.0', 20, '4.0', 30, '0.0', 42, -0.5, 70, 0]))
  })

  it('erased entities take with them the objects they own, and leave the GROUP and SORTENTSTABLE lists', () => {
    // As ezdxf writes them: a circle with an extension dictionary holding an XRECORD, two lines in a group.
    const CIRCLE: G = [0, 'CIRCLE', 5, '2F', 102, '{ACAD_XDICTIONARY', 360, '30', 102, '}', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbCircle', 10, 5, 20, 5, 30, 0, 40, 2]
    const line = (h: string, y: number): G => [0, 'LINE', 5, h, 102, '{ACAD_REACTORS', 330, '34', 102, '}', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbLine', 10, 0, 20, y, 30, 0, 11, 10, 21, y, 31, 0]
    const GROUP: G = [0, 'GROUP', 5, '34', 102, '{ACAD_REACTORS', 330, 'D', 102, '}', 330, 'D', 100, 'AcDbGroup', 300, '', 70, 0, 71, 1, 340, '32', 340, '33']
    const SORTENTS: G = [0, 'SORTENTSTABLE', 5, '36', 330, '35', 100, 'AcDbSortentsTable', 330, '1F', 331, '32', 5, 'FF', 331, '33', 5, 'FE', 331, '2F', 5, 'FD']
    const OBJECTS: G = [
      0, 'DICTIONARY', 5, 'C', 330, '0', 100, 'AcDbDictionary', 3, 'ACAD_GROUP', 350, 'D',
      0, 'DICTIONARY', 5, 'D', 330, 'C', 100, 'AcDbDictionary', 3, 'PAIR', 350, '34',
      0, 'DICTIONARY', 5, '30', 330, '2F', 100, 'AcDbDictionary', 280, 1, 281, 1, 3, 'ROYALE', 350, '31',
      0, 'XRECORD', 5, '31', 330, '30', 100, 'AcDbXrecord', 280, 1, 1, 'kept',
      ...GROUP, ...SORTENTS,
    ]
    const d = readDxf(file([...CIRCLE, ...line('32', 0), ...line('33', 1)], 'AC1015', '100', OBJECTS))
    const objects = (text: string): string => text.slice(text.indexOf(lines([2, 'OBJECTS'])))
    expect(objects(writeDxf(d.doc, d.source))).toBe(objects(d.source.text))
    const [circle, first] = [...d.doc.entities()] as [Circle, Line]
    d.doc.transact('ERASE', (tx) => {
      tx.remove(circle.id)
      tx.remove(first.id)
    })
    const out = objects(writeDxf(d.doc, d.source))
    expect(out).not.toContain(lines([5, '30']))
    expect(out).not.toContain('XRECORD')
    expect(out).toContain(lines([...GROUP.slice(0, -4), 340, '33', 0, 'SORTENTSTABLE']))
    expect(out).toContain(lines([...SORTENTS.slice(0, 8), 330, '1F', 331, '33', 5, 'FE', 0, 'ENDSEC']))
    expect(out).toContain(lines([3, 'ACAD_GROUP', 350, 'D', 0, 'DICTIONARY', 5, 'D', 330, 'C', 100, 'AcDbDictionary', 3, 'PAIR', 350, '34']))
    // A group left empty goes, and its entry with it.
    d.doc.transact('ERASE', (tx) => tx.remove([...d.doc.entities()][0]!.id))
    const none = objects(writeDxf(d.doc, d.source))
    expect(none).not.toContain(lines([0, 'GROUP']))
    expect(none).toContain(lines([0, 'DICTIONARY', 5, 'D', 330, 'C', 100, 'AcDbDictionary', 0, 'SORTENTSTABLE']))
  })

  it('read, edit, write, read: the same document; opaque text identical; extra groups and OCS survive the edit', () => {
    const d = readDxf(file([...LINE, ...CIRCLE, ...HATCH, ...LWPOLY]))
    const [line, circle, , poly] = [...d.doc.entities()] as [Line, Circle, Entity, Polyline]
    d.doc.transact('edit', (tx) => {
      tx.replace({ ...line, x1: 20, color: 1 })
      tx.replace({ ...circle, cx: 8 })
      tx.replace({ ...poly, pts: new Float64Array([0, 0, 4, 0, 4, 4]), bulges: new Float64Array([0, 0.5, 0]), closed: true })
      tx.add({ type: 'arc', layer: 1, cx: 1, cy: 2, r: 3, a0: 0, a1: Math.PI / 2 })
    })
    const out = writeDxf(d.doc, d.source)
    const back = readDxf(out)
    same([...d.doc.entities()], [...back.doc.entities()])
    // The edited line kept its handle, linetype, lineweight and extended data.
    const lineText = back.source.text.slice(back.source.loaded(1)!.start, back.source.loaded(1)!.end)
    expect(lineText).toContain(lines([6, 'DASHED', 370, 25]))
    expect(lineText).toContain(lines([1001, 'ROYALE', 1000, 'kept']))
    expect(back.source.handleOf(1)).toBe('20')
    // The mirrored circle stayed in its OCS.
    const circleText = back.source.text.slice(back.source.loaded(2)!.start, back.source.loaded(2)!.end)
    expect(circleText).toContain(lines([10, '-8.0']))
    expect(circleText).toContain(lines([230, -1]))
    expect([...back.doc.entities()][2]!).toMatchObject({ type: 'opaque', raw: lines(HATCH) })
  })

  it('a ByBlock entity stays ByBlock: moved, its record keeps 62 0, and a copy of it is ByBlock too', () => {
    const BYBLOCK: G = [0, 'LINE', 5, '20', 330, '1F', 100, 'AcDbEntity', 8, 'Walls', 62, 0, 100, 'AcDbLine', 10, 0, 20, 0, 30, 0, 11, 10, 21, 0, 31, 0]
    const t = commandBench()
    const d = drawingFrom(t.doc, parseDxf(file(BYBLOCK)))
    t.run('MOVE⏎ALL⏎⏎0,0⏎0,5⏎')
    t.run('COPY⏎ALL⏎⏎0,0⏎0,5⏎⏎')
    const out = writeDxf(t.doc, d.source)
    expect(out).toContain(lines([5, '20', 330, '1F', 100, 'AcDbEntity', 8, 'Walls', 62, 0, 100, 'AcDbLine', 10, '0.0', 20, '5.0']))
    const records = out.split(/\r\n  0\r\nLINE\r\n/).slice(1)
    expect(records).toHaveLength(2)
    for (const r of records) expect(r).toContain(lines([8, 'Walls', 62, 0]))
    expect([...readDxf(out).doc.entities()].map((e) => e.color)).toEqual([BY_BLOCK, BY_BLOCK])
  })

  it('new handles start at $HANDSEED, none repeats, and $HANDSEED moves past them', () => {
    const d = readDxf(file([...LINE, ...CIRCLE], 'AC1015', '30'))
    const [line, circle] = [...d.doc.entities()] as [Line, Circle]
    d.doc.transact('edit', (tx) => {
      for (let i = 0; i < 3; i++) tx.add({ ...line, y0: i, y1: i })
      tx.replace({ type: 'arc', id: circle.id, layer: 0, cx: 0, cy: 0, r: 1, a0: 0, a1: 1 }) // a circle trimmed into an arc
      tx.add({ type: 'polyline', layer: 0, pts: new Float64Array([0, 0, 1, 1]), bulges: null, closed: false })
    })
    const out = writeDxf(d.doc, d.source)
    const hs = handles(out)
    expect(new Set(hs).size).toBe(hs.length)
    const fresh = hs.filter((h) => !['2', '10', '11', '1', '1F', '20', '21', 'C'].includes(h)).map((h) => parseInt(h, 16))
    expect(fresh).toEqual([0x30, 0x31, 0x32, 0x33])
    const back = readDxf(out)
    expect(back.source.header.get('$HANDSEED')).toBe('34')
    // The arc that was a circle keeps the circle's handle.
    expect(back.source.handleOf(2)).toBe('21')
    expect([...back.doc.entities()][1]).toMatchObject({ type: 'arc' })
  })

  it('the LAYER table follows the document: a changed layer is patched, a new one added', () => {
    const d = readDxf(file(LINE))
    d.doc.layers.update(d.doc.layers.indexOf('Walls'), { visible: false, color: 1 })
    d.doc.layers.add({ name: 'New', color: TRUE_COLOR | 0x123456, visible: true, locked: true })
    const back = readDxf(writeDxf(d.doc, d.source))
    const layer = (name: string) => back.doc.layers.get(back.doc.layers.indexOf(name))
    expect(layer('Walls')).toEqual({ name: 'Walls', color: 1, visible: false, locked: false })
    // AC1015 holds no true colors: the nearest ACI color.
    expect(layer('New')).toEqual({ name: 'New', color: nearestAci(0x123456), visible: true, locked: true })
    const out = writeDxf(d.doc, d.source)
    expect(out).toContain(lines([2, 'Walls', 70, 0, 62, -1]))
    expect(handles(out).filter((h) => h === '100')).toHaveLength(1)
  })

  it('open and save without edits keeps the LAYER table, however the reader named the layers', () => {
    const line = (handle: string, layer: string): G => [0, 'LINE', 5, handle, 8, layer, 10, 0, 20, 0, 30, 0, 11, 1, 21, 1, 31, 0]
    // An xref-dependent layer (70 bit 16) whose name, its | replaced, is a layer of the drawing.
    const text = r12(
      [[2, '0', 70, 0, 62, 7, 6, 'CONTINUOUS'], [2, 'PLAN|WALLS', 70, 48, 62, 1, 6, 'CONTINUOUS'], [2, 'PLAN_WALLS', 70, 0, 62, 2, 6, 'CONTINUOUS']],
      [...line('20', 'PLAN|WALLS'), ...line('21', 'PLAN_WALLS')],
    )
    const d = readDxf(text)
    expect(writeDxf(d.doc, d.source)).toBe(text)
    // Only an xref layer: no layer comes with each save.
    const only = r12([[2, 'X|Y', 70, 48, 62, 3, 6, 'CONTINUOUS']], line('20', 'X|Y'))
    let again = readDxf(only)
    for (let k = 0; k < 2; k++) {
      expect(writeDxf(again.doc, again.source)).toBe(only)
      again = readDxf(writeDxf(again.doc, again.source))
    }
    expect(layerNames(again)).toEqual(['0', 'X_Y'])
    // Two entries for one name, case aside: the reader took the first, so an edit patches that one.
    const twice = readDxf(r12([[2, 'Walls', 70, 0, 62, 3, 6, 'CONTINUOUS'], [2, 'WALLS', 70, 0, 62, 5, 6, 'CONTINUOUS']], []))
    twice.doc.layers.update(twice.doc.layers.indexOf('Walls'), { color: 1 })
    expect(readDxf(writeDxf(twice.doc, twice.source)).doc.layers.get(1)).toMatchObject({ name: 'Walls', color: 1 })
  })

  it('a layer renamed on reading keeps its entry: edited, new and untouched entities stay on it, and no layer is added', () => {
    const LAYERS: G[] = [[2, '0', 70, 0, 62, 7, 6, 'CONTINUOUS'], [2, 'ROADS/MAIN', 70, 0, 62, 3, 6, 'CONTINUOUS']]
    const text = r12(LAYERS, [
      0, 'LINE', 5, '20', 8, 'ROADS/MAIN', 10, 0, 20, 0, 30, 0, 11, 10, 21, 0, 31, 0,
      0, 'LINE', 5, '21', 8, 'ROADS/MAIN', 10, 0, 20, 5, 30, 0, 11, 10, 21, 5, 31, 0,
    ], [9, '$CLAYER', 8, 'ROADS/MAIN'])
    const d = readDxf(text)
    expect(d.warnings).toEqual(['Layer "ROADS/MAIN" renamed "ROADS_MAIN": its name has characters layers cannot have.'])
    const roads = d.doc.layers.indexOf('ROADS_MAIN')
    // Unedited, with the renamed layer current: the file as read.
    expect(writeDxf(d.doc, d.source, { currentLayer: 'ROADS_MAIN' })).toBe(text)
    const [moved] = [...d.doc.entities()] as [Line]
    d.doc.transact('edit', (tx) => {
      tx.replace({ ...moved, x0: 1, x1: 11 })
      tx.add({ type: 'line', layer: roads, x0: 0, y0: 9, x1: 10, y1: 9 })
    })
    const out = writeDxf(d.doc, d.source, { currentLayer: 'ROADS_MAIN' })
    expect(out).toContain(lines([2, 'ROADS/MAIN', 70, 0, 62, 3]))
    expect(out.split(lines([0, 'LAYER']))).toHaveLength(3) // two entries
    expect(out).toContain(lines([9, '$CLAYER', 8, 'ROADS/MAIN']))
    const back = readDxf(out)
    expect(layerNames(back)).toEqual(['0', 'ROADS_MAIN'])
    expect([...back.doc.entities()].map((e) => e.layer)).toEqual([1, 1, 1])
    // Saved again: nothing more.
    expect(writeDxf(back.doc, back.source, { currentLayer: 'ROADS_MAIN' })).toBe(out)
  })

  it('layer state: off and frozen stays off when its color changes; -LAYER Freeze is saved frozen, not off', () => {
    const text = r12([[2, '0', 70, 0, 62, 7, 6, 'CONTINUOUS'], [2, 'OFFFROZEN', 70, 1, 62, -6, 6, 'CONTINUOUS'], [2, 'WALLS', 70, 0, 62, 3, 6, 'CONTINUOUS']], [])
    const t = commandBench()
    const d = drawingFrom(t.doc, parseDxf(text))
    t.run('-LAYER⏎C⏎1⏎OFFFROZEN⏎F⏎WALLS⏎⏎')
    const out = writeDxf(t.doc, d.source)
    expect(out).toContain(lines([2, 'OFFFROZEN', 70, 1, 62, -1]))
    expect(out).toContain(lines([2, 'WALLS', 70, 1, 62, 3]))
    const back = readDxf(out)
    expect(back.doc.layers.get(back.doc.layers.indexOf('WALLS'))).toMatchObject({ visible: false, frozen: true })
    // Thawed, it shows again and is saved thawed.
    t.run('-LAYER⏎T⏎WALLS⏎⏎')
    expect(writeDxf(t.doc, d.source)).toContain(lines([2, 'WALLS', 70, 0, 62, 3]))
  })

  it('ELLIPSE and SPLINE: edits are patched in place (handle, linetype, a mirrored frame kept), new ones written fresh', () => {
    const ELLIPSE: G = [0, 'ELLIPSE', 5, '30', 330, '1F', 100, 'AcDbEntity', 8, '0', 6, 'DASHED', 100, 'AcDbEllipse', 10, 10, 20, 20, 30, 0, 11, 6, 21, 8, 31, 0, 210, 0, 220, 0, 230, -1, 40, 0.5, 41, 0.5, 42, 4]
    const knots = [0, 0, 0, 0, 1, 1, 1, 1].flatMap((k) => [40, k])
    const ctrl = [[0, 0], [1, 2], [3, 2], [4, 0]].flatMap(([x, y]) => [10, x!, 20, y!, 30, 0])
    const SPLINE: G = [0, 'SPLINE', 5, '31', 330, '1F', 100, 'AcDbEntity', 8, 'Walls', 6, 'DASHED', 100, 'AcDbSpline', 210, 0, 220, 0, 230, 1, 70, 8, 71, 3, 72, 8, 73, 4, 74, 2, 42, 1e-10, 43, 1e-10, 44, 1e-10, 12, 1, 22, 0, 32, 0, 13, 1, 23, 0, 33, 0, ...knots, ...ctrl, 11, 0, 21, 0, 31, 0, 11, 4, 21, 0, 31, 0, 1001, 'ROYALE', 1000, 'kept']
    const d = readDxf(file([...ELLIPSE, ...SPLINE]))
    const [el, sp] = [...d.doc.entities()] as [Ellipse, Spline]
    d.doc.transact('edit', (tx) => {
      tx.replace({ ...el, cx: 15, t1: el.t1 - 0.25 })
      tx.replace({ ...sp, ctrl: sp.ctrl.map((v, i) => (i % 2 === 0 ? v + 5 : v)), weights: Float64Array.of(1, 2, 2, 1) })
      tx.add({ type: 'ellipse', layer: 0, cx: 1, cy: 2, mx: 0, my: 3, ratio: 0.25, t0: 0, t1: 0 })
      tx.add({ type: 'spline', layer: 0, degree: 2, closed: false, knots: Float64Array.of(0, 0, 0, 1, 1, 1), ctrl: Float64Array.of(0, 0, 1, 1, 2, 0), weights: null })
    })
    const out = writeDxf(d.doc, d.source)
    const back = readDxf(out)
    expect(back.warnings).toEqual([])
    const got = [...back.doc.entities()]
    const want = [...d.doc.entities()]
    const angles = ({ id: _id, t0, t1, ...rest }: Ellipse) => [rest, Math.round(t0 * 1e12), Math.round(t1 * 1e12)]
    expect(angles(got[0] as Ellipse)).toEqual(angles(want[0] as Ellipse))
    expect(angles(got[2] as Ellipse)).toEqual(angles(want[2] as Ellipse))
    expect((got[2] as Ellipse).t0).toBe((got[2] as Ellipse).t1)
    same([want[1]!, want[3]!], [got[1]!, got[3]!])
    const text = (id: number): string => back.source.text.slice(back.source.loaded(id)!.start, back.source.loaded(id)!.end)
    expect(back.source.handleOf(1)).toBe('30')
    expect(text(1)).toContain(lines([6, 'DASHED']))
    expect(text(1)).toContain(lines([230, -1]))
    expect(back.source.handleOf(2)).toBe('31')
    expect(text(2)).toContain(lines([1001, 'ROYALE', 1000, 'kept']))
    // The fit points and tangents no longer match the control points: gone, and said so.
    expect(text(2)).not.toContain(lines([11, '0.0']))
    expect(text(2)).not.toContain(lines([12, '1.0']))
    expect(text(2)).toContain(lines([74, 0]))
  })

  it('INSERT: an edit is patched in its OCS and moves its attributes with it; a copy is written fresh', () => {
    const BLOCKS: G = [0, 'SECTION', 2, 'BLOCKS',
      0, 'BLOCK', 5, '40', 8, '0', 100, 'AcDbEntity', 100, 'AcDbBlockBegin', 2, 'DOOR', 70, 2, 10, 0, 20, 0, 30, 0, 3, 'DOOR',
      0, 'LINE', 5, '41', 8, '0', 100, 'AcDbEntity', 100, 'AcDbLine', 10, 0, 20, 0, 30, 0, 11, 1, 21, 0, 31, 0,
      0, 'ATTDEF', 5, '42', 8, '0', 100, 'AcDbEntity', 100, 'AcDbText', 10, 0, 20, 1, 30, 0, 40, 0.25, 1, '', 100, 'AcDbAttributeDefinition', 3, 'Tag?', 2, 'TAG', 70, 0,
      0, 'ENDBLK', 5, '43', 8, '0', 100, 'AcDbEntity', 100, 'AcDbBlockEnd',
      0, 'ENDSEC']
    const WITH_ATTRIB: G = [0, 'INSERT', 5, '50', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockReference', 66, 1, 2, 'DOOR', 10, 10, 20, 20, 30, 0,
      0, 'ATTRIB', 5, '51', 330, '50', 100, 'AcDbEntity', 8, '0', 100, 'AcDbText', 10, 10, 20, 21, 30, 0, 40, 0.25, 1, 'D1', 100, 'AcDbAttribute', 2, 'TAG', 70, 0,
      0, 'SEQEND', 5, '52', 330, '50', 100, 'AcDbEntity', 8, '0']
    const MIRRORED: G = [0, 'INSERT', 5, '53', 330, '1F', 100, 'AcDbEntity', 8, 'Walls', 100, 'AcDbBlockReference', 2, 'DOOR', 10, 5, 20, 5, 30, 0, 41, 2, 50, 30, 210, 0, 220, 0, 230, -1]
    const text = file([...WITH_ATTRIB, ...MIRRORED]).replace(lines([0, 'SECTION', 2, 'ENTITIES']), lines(BLOCKS) + lines([0, 'SECTION', 2, 'ENTITIES']))
    const d = readDxf(text)
    expect(d.warnings).toEqual([])
    const [door, mirrored] = [...d.doc.entities()] as [Insert, Insert]
    d.doc.transact('edit', (tx) => {
      tx.replace(typeOf(door).transform!({ ...door, x: 15 }, rotation({ x: 15, y: 20 }, 90)))
      tx.replace({ ...mirrored, sy: 3, rotation: mirrored.rotation + 0.5 })
      tx.add({ ...door, x: 100 })
    })
    const out = writeDxf(d.doc, d.source)
    const back = readDxf(out)
    expect(back.warnings).toEqual([])
    const got = [...back.doc.entities()] as Insert[]
    const want = [...d.doc.entities()] as Insert[]
    const round = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'number' ? Math.round(x * 1e12) / 1e12 + 0 : x)))
    expect(got.map(({ id: _id, block, ...rest }) => [round(rest), block.name])).toEqual(want.map(({ id: _id, block, ...rest }) => [round(rest), block.name]))
    const span = (id: number): string => back.source.text.slice(back.source.loaded(id)!.start, back.source.loaded(id)!.end)
    // The attribute, a text in the world, turned about (15, 20) with its insert: from (10, 21) to (14, 15).
    expect(span(1)).toContain(lines([0, 'ATTRIB', 5, '51']))
    expect(span(1)).toContain(lines([10, '14.0', 20, '15.0']))
    expect(span(1)).toContain(lines([50, '90.0']))
    expect(span(1)).toContain(lines([0, 'SEQEND']))
    expect(back.source.handleOf(2)).toBe('53')
    expect(span(2)).toContain(lines([230, -1]))
    // The copy has its attributes too, owned by it, and ends in a SEQEND.
    const copy = back.source.handleOf(3)!
    expect(span(3)).toContain(lines([66, 1]))
    expect(span(3)).toContain(lines([0, 'ATTRIB']))
    expect(span(3)).toContain(lines([330, copy]))
    expect(span(3)).toContain(lines([2, 'TAG', 70, 0]))
    expect(span(3)).toContain(lines([0, 'SEQEND']))
    expect(got[2]!.attribs).toEqual(want[2]!.attribs)
  })

  it('TEXT and MTEXT: edits are patched in place (handle, style, extra groups kept), new ones written fresh; all read back the same', () => {
    const TEXT: G = [0, 'TEXT', 5, '60', 330, '1F', 100, 'AcDbEntity', 8, 'Walls', 100, 'AcDbText', 10, 4.5, 20, 5.5, 30, 0, 40, 1, 1, 'MC', 7, 'ROMANS', 72, 1, 11, 5, 21, 6, 31, 0, 100, 'AcDbText', 73, 2, 1001, 'ROYALE', 1000, 'kept']
    const MTEXT: G = [0, 'MTEXT', 5, '61', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbMText', 10, 0, 20, 10, 30, 0, 40, 2, 41, 20, 71, 1, 72, 1, 3, 'two ', 1, 'chunks\\Pand a paragraph', 7, 'Standard', 11, 1, 21, 0, 31, 0, 73, 1, 44, 1]
    const d = readDxf(file([...TEXT, ...MTEXT]))
    expect(d.warnings).toEqual([])
    const [t, m] = [...d.doc.entities()] as [Text, MText]
    const long = 'x'.repeat(300) + '\\P' + 'y'.repeat(260)
    d.doc.transact('edit', (tx) => {
      tx.replace({ ...t, x: 15, x2: 15, rotation: Math.PI / 2 })
      tx.replace({ ...m, rotation: 0.5, x: 3 })
      tx.add({ type: 'text', layer: 0, value: 'new', x: 1, y: 2, x2: 1, y2: 2, height: 2.5, rotation: 0, widthFactor: 0.8, oblique: -0.25, halign: 0, valign: 0, backward: true, upsideDown: false })
      tx.add({ type: 'text', layer: 0, value: 'TR', x: 9, y: 9, x2: 9, y2: 9, height: 1, rotation: 0.25, widthFactor: 1, oblique: 0, halign: 2, valign: 3, backward: false, upsideDown: false })
      tx.add({ type: 'text', layer: 0, value: 'fit', x: 0, y: 0, x2: 10, y2: 0, height: 1, rotation: 0, widthFactor: 1, oblique: 0, halign: 5, valign: 0, backward: false, upsideDown: false })
      tx.add({ type: 'mtext', layer: 0, value: long, x: 1, y: 1, height: 1, width: 0, attachment: 5, rotation: 1, spacing: 1.25 })
    })
    const out = writeDxf(d.doc, d.source)
    const back = readDxf(out)
    expect(back.warnings).toEqual([])
    const round = (e: Entity): unknown => JSON.parse(JSON.stringify(e, (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 + 0 : v)))
    expect([...back.doc.entities()].map(round)).toEqual([...d.doc.entities()].map(round))
    const span = (id: number): string => back.source.text.slice(back.source.loaded(id)!.start, back.source.loaded(id)!.end)
    expect(back.source.handleOf(1)).toBe('60')
    expect(span(1)).toContain(lines([7, 'ROMANS']))
    expect(span(1)).toContain(lines([1001, 'ROYALE', 1000, 'kept']))
    expect(span(1)).toContain(lines([50, '90.0']))
    expect(back.source.handleOf(2)).toBe('61')
    expect(span(2)).toContain(lines([7, 'Standard']))
    // A left and baseline text has no second point; a justified one starts its baseline at 10, placed by 11.
    expect(span(3)).not.toContain(lines([11, '1.0']))
    expect(span(4)).toContain(lines([72, 2, 11, '9.0', 21, '9.0']))
    // DXF strings hold 255 characters: a long MTEXT goes in chunks of 3, then 1.
    expect(span(6)).toContain('\r\n  3\r\n')
    for (const l of span(6).split('\r\n')) expect(l.length).toBeLessThanOrEqual(255)
  })

  it('an R12 file has no MTEXT: each of its lines goes as a TEXT where the line shows', () => {
    const d = readDxf(lines([0, 'SECTION', 2, 'ENTITIES', 0, 'ENDSEC', 0, 'EOF'], '\n'))
    d.doc.transact('add', (tx) => void tx.add({ type: 'mtext', layer: 0, value: 'A\\PB', x: 0, y: 0, height: 1, width: 0, attachment: 1, rotation: 0, spacing: 1 }))
    const out = writeDxf(d.doc, d.source)
    expect(out).not.toContain('MTEXT')
    const [a, b] = [...readDxf(out).doc.entities()] as [Text, Text]
    expect([a.value, a.x, a.y, a.height, a.halign]).toEqual(['A', 0, -1, 1, 0])
    expect([b.value, b.x, Math.round(b.y * 1e12)]).toEqual(['B', 0, Math.round((-1 - 5 / 3) * 1e12)])
  })

  it('an R12 file has no ELLIPSE nor SPLINE: they go as polylines close to them', () => {
    const text = lines([0, 'SECTION', 2, 'ENTITIES', 0, 'ENDSEC', 0, 'EOF'], '\n')
    const d = readDxf(text)
    d.doc.transact('add', (tx) => {
      tx.add({ type: 'ellipse', layer: 0, cx: 0, cy: 0, mx: 10, my: 0, ratio: 0.5, t0: 0, t1: 0 })
      tx.add({ type: 'spline', layer: 0, degree: 2, closed: false, knots: Float64Array.of(0, 0, 0, 1, 1, 1), ctrl: Float64Array.of(0, 0, 1, 1, 2, 0), weights: null })
    })
    const back = readDxf(writeDxf(d.doc, d.source))
    const [e, s] = [...back.doc.entities()] as [Polyline, Polyline]
    expect([e.type, e.closed, s.type, s.closed]).toEqual(['polyline', true, 'polyline', false])
    for (let i = 0; i < e.pts.length; i += 2) expect(Math.hypot(e.pts[i]! / 10, e.pts[i + 1]! / 5)).toBeCloseTo(1, 9)
    expect([s.pts[0], s.pts[1], s.pts.at(-2), s.pts.at(-1)]).toEqual([0, 0, 2, 0])
  })

  it('an R12 file gets R12 records: no subclass markers, POLYLINE with VERTEX and SEQEND', () => {
    const text = lines([0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 1, 21, 1, 0, 'ENDSEC', 0, 'EOF'], '\n')
    const d = readDxf(text)
    d.doc.transact('add', (tx) => void tx.add({ type: 'polyline', layer: 0, pts: new Float64Array([0, 0, 1, 0, 1, 1]), bulges: new Float64Array([0, 1, 0]), closed: true }))
    const out = writeDxf(d.doc, d.source)
    expect(out).not.toContain('AcDb')
    expect(out.split('\n').filter((l) => l === 'VERTEX')).toHaveLength(3)
    expect(out).toContain('SEQEND')
    expect(out.includes('\r')).toBe(false)
    same([...d.doc.entities()], [...readDxf(out).doc.entities()])
  })

  it('a new document becomes an AC1015 file that reads back the same', () => {
    const doc = createDocument()
    const walls = doc.layers.add({ name: 'Walls', color: 3, visible: true, locked: false })
    doc.transact('draw', (tx) => {
      tx.add({ type: 'line', layer: walls, x0: 0, y0: 0, x1: 10, y1: 5 })
      tx.add({ type: 'circle', layer: 0, color: 1, cx: 3, cy: 4, r: 2 })
      tx.add({ type: 'arc', layer: 0, cx: 0, cy: 0, r: 5, a0: Math.PI / 2, a1: Math.PI })
      tx.add({ type: 'point', layer: 0, x: 7, y: 8 })
      tx.add({ type: 'polyline', layer: 0, pts: new Float64Array([0, 0, 4, 0]), bulges: new Float64Array([0.25, 0]), closed: false })
    })
    const out = writeDxf(doc, undefined, { currentLayer: 'Walls' })
    const back = readDxf(out)
    expect(back.warnings).toEqual([])
    expect(back.source.header.get('$CLAYER')).toBe('Walls')
    expect(back.source.header.get('$ACADVER')).toBe('AC1015')
    const strip = (es: Entity[]) => es.map(({ id: _id, ...rest }) => rest)
    const got = strip([...back.doc.entities()])
    const want = strip([...doc.entities()])
    expect(got.length).toBe(want.length)
    // Angles go through degrees: equal within rounding.
    const arc = got[2] as Omit<Arc, 'id'>
    expect(arc.a0).toBeCloseTo(Math.PI / 2, 12)
    expect({ ...got[2], a0: 0, a1: 0 }).toEqual({ ...want[2], a0: 0, a1: 0 })
    expect([got[0], got[1], got[3], got[4]]).toEqual([want[0], want[1], want[3], want[4]])
    expect(back.doc.layers.get(back.doc.layers.indexOf('Walls'))).toEqual({ name: 'Walls', color: 3, visible: true, locked: false })
    const hs = handles(out)
    expect(new Set(hs).size).toBe(hs.length)
    expect(parseInt(back.source.header.get('$HANDSEED')!, 16)).toBeGreaterThan(Math.max(...hs.map((h) => parseInt(h, 16))))
  })
})
