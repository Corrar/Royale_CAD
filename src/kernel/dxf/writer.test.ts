import { describe, expect, it } from 'vitest'
import { TRUE_COLOR } from '../color'
import { createDocument } from '../document'
import type { Arc, Circle, Entity, Line, Polyline } from '../entity/types'
import { readDxf } from './reader'
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
function file(entities: G, version = 'AC1015', seed = '100'): string {
  return lines([
    0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, version, 9, '$HANDSEED', 5, seed, 0, 'ENDSEC',
    0, 'SECTION', 2, 'TABLES', ...LAYERS, 0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES', ...entities, 0, 'ENDSEC',
    0, 'SECTION', 2, 'OBJECTS', 0, 'DICTIONARY', 5, 'C', 330, '0', 100, 'AcDbDictionary', 0, 'ENDSEC',
    0, 'EOF',
  ])
}

const LINE: G = [0, 'LINE', 5, '20', 330, '1F', 100, 'AcDbEntity', 8, 'Walls', 6, 'DASHED', 370, 25, 100, 'AcDbLine', 10, 0, 20, 0, 30, 0, 11, 10, 21, 0, 31, 0, 1001, 'ROYALE', 1000, 'kept']
const CIRCLE: G = [0, 'CIRCLE', 5, '21', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbCircle', 10, 5, 20, 1, 30, 0, 40, 1, 210, 0, 220, 0, 230, -1]
const HATCH: G = [0, 'HATCH', 5, '22', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbHatch', 10, 0, 20, 0, 30, 0, 2, 'SOLID']
const LWPOLY: G = [0, 'LWPOLYLINE', 5, '23', 330, '1F', 100, 'AcDbEntity', 8, '0', 100, 'AcDbPolyline', 90, 2, 70, 0, 43, 0, 10, 0, 20, 0, 10, 4, 20, 0, 210, 0, 220, 0, 230, 1]

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

describe('writeDxf', () => {
  it('a file written back without edits is the file read, byte for byte', () => {
    const text = file([...LINE, ...CIRCLE, ...HATCH, ...LWPOLY])
    const d = readDxf(text)
    expect(writeDxf(d.doc, d.source)).toBe(text)
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
    const out = writeDxf(doc)
    const back = readDxf(out)
    expect(back.warnings).toEqual([])
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
