import { TRUE_COLOR, aciRgb, type Color } from '../color'
import { docExtents, type Document, type Layer } from '../document'
import { typeOf } from '../entity/registry'
import { insertAffines } from '../entity/insert'
import type { Attrib, Ellipse, Entity, Insert, MText, Polyline, Spline, Text } from '../entity/types'
import { affineDet, applyAffine, type Affine } from '../geom/vec'
import { TAU, normAngle } from '../geom/tol'
import { baselineStart, mtextLines } from '../text/layout'
import type { DxfSource } from './reader'
import { entryEnd, findTable, groupValue, layerEntry, type TableRange } from './tables'
import { FIRST_FREE_HANDLE, H, TEXTSIZE, textSizeOf, writeTemplate } from './template'
import { tokenize, type PairList } from './tokenizer'

/** A group code as AutoCAD lays it out: right-aligned in three columns. */
export const codeText = (c: number): string => (c >= 0 && c < 10 ? '  ' : c >= 0 && c < 100 ? ' ' : '') + c

/** A real that reads back to the same double: shortest digits, always a decimal point, E for exponents. */
export function real(x: number): string {
  if (x === 0) return '0.0'
  const s = String(x)
  if (!s.includes('e')) return s.includes('.') ? s : `${s}.0`
  const [m, e] = x.toExponential().split('e') as [string, string]
  return `${m.includes('.') ? m : `${m}.0`}E${e[0] === '-' ? '-' : '+'}${e.replace(/^[+-]/, '').padStart(2, '0')}`
}

/** Collects DXF text, one group at a time, with the file's line break. */
export function emitter(nl: string) {
  const parts: string[] = []
  return {
    str(code: number, v: string): void {
      parts.push(codeText(code), nl, v, nl)
    },
    int(code: number, v: number): void {
      parts.push(codeText(code), nl, String(Math.trunc(v)), nl)
    },
    real(code: number, v: number): void {
      parts.push(codeText(code), nl, real(v), nl)
    },
    /** Text already laid out as groups, with the same line break. */
    raw(text: string): void {
      parts.push(text)
    },
    text: (): string => parts.join(''),
  }
}
export type Emitter = ReturnType<typeof emitter>

/** The ACI color nearest an RGB color, for files that cannot hold true colors. */
export function nearestAci(rgb: number): number {
  let best = 7
  let bestD = Infinity
  for (let i = 1; i <= 255; i++) {
    const c = aciRgb(i)
    const d = ((c >> 16) - (rgb >> 16)) ** 2 + (((c >> 8) & 255) - ((rgb >> 8) & 255)) ** 2 + ((c & 255) - (rgb & 255)) ** 2
    if (d < bestD) {
      best = i
      bestD = d
    }
  }
  return best
}

/** What the file's version allows. */
interface Flavor {
  /** R13 on (AC1012+): subclass markers (100) and owners (330). */
  modern: boolean
  /** R14 on: LWPOLYLINE. */
  lw: boolean
  /** 2004 on (AC1018+): true colors (420). */
  trueColor: boolean
  /** Entities carry handles: always from R13, in R12 only with $HANDLING. */
  handles: boolean
}

function flavorOf(version: string, handling: string | undefined): Flavor {
  const modern = version >= 'AC1012'
  return { modern, lw: version >= 'AC1014', trueColor: version >= 'AC1018', handles: modern || handling?.trim() === '1' }
}

function allocator(seed: number) {
  let next = seed
  return {
    take: (): string => (next++).toString(16).toUpperCase(),
    seed: (): string => next.toString(16).toUpperCase(),
  }
}
type Allocator = ReturnType<typeof allocator>

interface Ctx {
  o: Emitter
  f: Flavor
  ids: Allocator
  doc: Document
  /** The model space BLOCK_RECORD, owner of every entity; null when the file has none (R12). */
  owner: string | null
  /** The name each layer read has in the file, by index; later layers go by their own. */
  names: readonly string[]
}

/** Layer i as the file names it: a layer the reader renamed keeps its entry, and its entities stay on it. */
const fileLayer = (c: Ctx, i: number): string => c.names[i] ?? c.doc.layers.get(i)!.name

const layerName = (c: Ctx, e: Entity): string => fileLayer(c, e.layer)

function colorGroups(o: Emitter, f: Flavor, color: Color | undefined): void {
  if (color === undefined) return
  if (color < TRUE_COLOR) return o.int(62, color)
  o.int(62, nearestAci(color & 0xffffff))
  if (f.trueColor) o.int(420, color & 0xffffff)
}

/** Degrees in [0, 360) for an angle in radians. */
const deg = (a: number): number => (normAngle(a) * 180) / Math.PI

function head(c: Ctx, type: string, e: Entity, handle: string | null, subclass: string): void {
  const { o, f } = c
  o.str(0, type)
  if (handle) o.str(5, handle)
  if (f.modern) {
    if (c.owner) o.str(330, c.owner)
    o.str(100, 'AcDbEntity')
  }
  o.str(8, layerName(c, e))
  colorGroups(o, f, e.color)
  if (f.modern) o.str(100, subclass)
}

/** e as new groups; handle null in a file without handles. */
function fresh(c: Ctx, e: Entity, handle: string | null): void {
  const { o, f } = c
  switch (e.type) {
    case 'line':
      head(c, 'LINE', e, handle, 'AcDbLine')
      o.real(10, e.x0)
      o.real(20, e.y0)
      o.real(30, 0)
      o.real(11, e.x1)
      o.real(21, e.y1)
      o.real(31, 0)
      return
    case 'point':
      head(c, 'POINT', e, handle, 'AcDbPoint')
      o.real(10, e.x)
      o.real(20, e.y)
      o.real(30, 0)
      return
    case 'circle':
    case 'arc':
      head(c, e.type === 'circle' ? 'CIRCLE' : 'ARC', e, handle, 'AcDbCircle')
      o.real(10, e.cx)
      o.real(20, e.cy)
      o.real(30, 0)
      o.real(40, e.r)
      if (e.type === 'arc') {
        if (f.modern) o.str(100, 'AcDbArc')
        o.real(50, deg(e.a0))
        o.real(51, deg(e.a1))
      }
      return
    case 'polyline':
      return f.lw ? lwpolyline(c, e, handle) : oldPolyline(c, e, handle)
    case 'opaque':
      o.raw(e.raw)
      return
    case 'ellipse':
      if (!f.modern) return oldPolyline(c, asPolyline(e), handle)
      head(c, 'ELLIPSE', e, handle, 'AcDbEllipse')
      o.real(10, e.cx)
      o.real(20, e.cy)
      o.real(30, 0)
      o.real(11, e.mx)
      o.real(21, e.my)
      o.real(31, 0)
      o.real(40, e.ratio)
      o.real(41, e.t0)
      o.real(42, ellipseEnd(e))
      return
    case 'insert': {
      // A copy: the block reference, then its attributes, owned by it, and a SEQEND. A grid is a MINSERT.
      const grid = e.cols > 1 || e.rows > 1
      const attribs = e.attribs ?? []
      head(c, 'INSERT', e, handle, grid ? 'AcDbMInsertBlock' : 'AcDbBlockReference')
      if (attribs.length > 0) o.int(66, 1)
      o.str(2, e.block.name)
      o.real(10, e.x)
      o.real(20, e.y)
      o.real(30, 0)
      if (e.sx !== 1) o.real(41, e.sx)
      if (e.sy !== 1) o.real(42, e.sy)
      if (e.rotation !== 0) o.real(50, deg(e.rotation))
      if (grid) {
        o.int(70, e.cols)
        o.int(71, e.rows)
        o.real(44, e.dx)
        o.real(45, e.dy)
      }
      if (attribs.length === 0) return
      const take = (): string | null => (f.handles ? c.ids.take() : null)
      for (const a of attribs) freshAttrib(c, a, take(), handle)
      o.str(0, 'SEQEND')
      const seqend = take()
      if (seqend) o.str(5, seqend)
      if (f.modern) {
        if (handle) o.str(330, handle)
        o.str(100, 'AcDbEntity')
      }
      o.str(8, layerName(c, e))
      return
    }
    case 'text':
      return freshText(c, e, handle)
    case 'mtext': {
      if (!f.modern) {
        // R12 has no MTEXT: a TEXT for each line, where the line shows.
        mtextLines(e).forEach((l, k) => freshText(c, {
          type: 'text', id: e.id, layer: e.layer, ...(e.color !== undefined && { color: e.color }), value: l.text,
          x: l.x, y: l.y, x2: l.x, y2: l.y, height: e.height, rotation: e.rotation, widthFactor: 1, oblique: 0,
          halign: 0, valign: 0, backward: false, upsideDown: false,
        }, k === 0 ? handle : f.handles ? c.ids.take() : null))
        return
      }
      head(c, 'MTEXT', e, handle, 'AcDbMText')
      o.real(10, e.x)
      o.real(20, e.y)
      o.real(30, 0)
      o.real(40, e.height)
      o.real(41, e.width)
      o.int(71, e.attachment)
      o.int(72, 1)
      const chunks = chunksOf(e.value)
      for (let k = 0; k < chunks.length - 1; k++) o.str(3, chunks[k]!)
      o.str(1, chunks.at(-1)!)
      // The direction as a vector: 50 is in radians to some readers, in degrees to others.
      o.real(11, Math.cos(e.rotation))
      o.real(21, Math.sin(e.rotation))
      o.real(31, 0)
      o.int(73, 1)
      o.real(44, e.spacing)
      return
    }
    case 'spline':
      if (!f.modern) return oldPolyline(c, asPolyline(e), handle)
      head(c, 'SPLINE', e, handle, 'AcDbSpline')
      o.real(210, 0)
      o.real(220, 0)
      o.real(230, 1)
      // Planar, and closed or rational as the curve is.
      o.int(70, 8 | (e.closed ? 1 : 0) | (e.weights ? 4 : 0))
      o.int(71, e.degree)
      o.int(72, e.knots.length)
      o.int(73, e.ctrl.length >> 1)
      o.int(74, 0)
      for (const g of splineGroups(e, 0)) o.str(g[0], g[1])
  }
}

/**
 * TEXT: 10 starts the baseline; a justified text is placed by 11, and aligned and fit run from 10 to 11. Groups at
 * their defaults are left out.
 */
function freshText(c: Ctx, e: Text, handle: string | null): void {
  const { o, f } = c
  head(c, 'TEXT', e, handle, 'AcDbText')
  textBody(c, e)
  if (f.modern) o.str(100, 'AcDbText')
  if (e.valign !== 0) o.int(73, e.valign)
}

/** ATTRIB: a text's groups, then its tag, flags and vertical alignment (74). Owned by its insert. */
function freshAttrib(c: Ctx, a: Attrib, handle: string | null, owner: string | null): void {
  const { o, f } = c
  o.str(0, 'ATTRIB')
  if (handle) o.str(5, handle)
  if (f.modern) {
    if (owner) o.str(330, owner)
    o.str(100, 'AcDbEntity')
  }
  o.str(8, fileLayer(c, a.layer))
  colorGroups(o, f, a.color)
  if (f.modern) o.str(100, 'AcDbText')
  textBody(c, a)
  if (f.modern) o.str(100, 'AcDbAttribute')
  o.str(2, a.tag)
  o.int(70, a.hidden ? 1 : 0)
  if (a.valign !== 0) o.int(74, a.valign)
}

/** The groups TEXT and ATTRIB share: 10 through 11. */
function textBody(c: Ctx, e: Omit<Text, 'id'>): void {
  const { o } = c
  const [first, second] = textPoints(e)
  o.real(10, first.x)
  o.real(20, first.y)
  o.real(30, 0)
  o.real(40, e.height)
  o.str(1, e.value)
  if (e.rotation !== 0) o.real(50, deg(e.rotation))
  if (e.widthFactor !== 1) o.real(41, e.widthFactor)
  if (e.oblique !== 0) o.real(51, deg(e.oblique))
  const flags = textFlags(e)
  if (flags !== 0) o.int(71, flags)
  if (e.halign !== 0) o.int(72, e.halign)
  if (second) {
    o.real(11, second.x)
    o.real(21, second.y)
    o.real(31, 0)
  }
}

/** A TEXT's first alignment point (10) and, when it is justified, its second (11). */
function textPoints(e: Omit<Text, 'id'>): [{ x: number; y: number }, { x: number; y: number } | null] {
  if (e.halign === 3 || e.halign === 5) return [{ x: e.x, y: e.y }, { x: e.x2, y: e.y2 }]
  if (e.halign === 0 && e.valign === 0) return [{ x: e.x, y: e.y }, null]
  return [baselineStart(e), { x: e.x, y: e.y }]
}

const textFlags = (e: Omit<Text, 'id'>): number => (e.backward ? 2 : 0) | (e.upsideDown ? 4 : 0)

/** DXF strings hold 255 characters: MTEXT's value in pieces of 250, none splitting a surrogate pair. */
function chunksOf(s: string): string[] {
  const out: string[] = []
  let i = 0
  while (s.length - i > 250) {
    let j = i + 250
    const u = s.charCodeAt(j - 1)
    if (u >= 0xd800 && u <= 0xdbff) j--
    out.push(s.slice(i, j))
    i = j
  }
  out.push(s.slice(i))
  return out
}

/** The ELLIPSE end parameter: a whole ellipse ends a turn after it starts. */
const ellipseEnd = (e: Ellipse): number => (e.t0 === e.t1 ? e.t0 + TAU : e.t1)

/** Knots, weights and control points (at height z) as SPLINE groups. */
function splineGroups(e: Spline, z: number): [number, string][] {
  const gs: [number, string][] = []
  for (const k of e.knots) gs.push([40, real(k)])
  if (e.weights) for (const w of e.weights) gs.push([41, real(w)])
  for (let i = 0; i < e.ctrl.length; i += 2) gs.push([10, real(e.ctrl[i]!)], [20, real(e.ctrl[i + 1]!)], [30, real(z)])
  return gs
}

/** A curve R12 cannot hold, as a polyline within a hundred-thousandth of its size (AutoCAD's R12 export does as much). */
function asPolyline(e: Ellipse | Spline): Polyline {
  const b = typeOf(e).bbox(e)
  const pts: number[] = []
  typeOf(e).primitives(e, 1e-5 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY), {
    segment(x0, y0, x1, y1) {
      if (pts.length === 0) pts.push(x0, y0)
      pts.push(x1, y1)
    },
    arc() {},
  })
  const closed = e.type === 'ellipse' ? e.t0 === e.t1 : e.closed
  // Closed, the last point is the first again.
  if (closed && pts.length > 2) pts.length -= 2
  return { type: 'polyline', id: e.id, layer: e.layer, color: e.color, pts: new Float64Array(pts), bulges: null, closed } as Polyline
}

/**
 * e's widths as an LWPOLYLINE holds them: one constant width (43), or each vertex's own (40, 41; null when all are
 * 0). Default start and end widths that differ go to every vertex.
 */
function lwWidths(e: Polyline): { constant: number; widths: Float64Array | null } {
  const s = e.startWidth ?? 0
  const t = e.endWidth ?? 0
  if (!e.widths && s === t) return { constant: s, widths: null }
  return { constant: 0, widths: e.widths ?? Float64Array.from({ length: e.pts.length }, (_, i) => (i % 2 === 0 ? s : t)) }
}

/** An LWPOLYLINE's vertex groups, x by s (±1, its OCS): 10 and 20, then widths and bulge unless 0. */
function lwVertices(e: Polyline, widths: Float64Array | null, s: number): [number, string][] {
  const gs: [number, string][] = []
  for (let k = 0; k < e.pts.length >> 1; k++) {
    gs.push([10, real(s * e.pts[2 * k]!)], [20, real(e.pts[2 * k + 1]!)])
    if (widths && (widths[2 * k] !== 0 || widths[2 * k + 1] !== 0)) gs.push([40, real(widths[2 * k]!)], [41, real(widths[2 * k + 1]!)])
    const b = e.bulges?.[k] ?? 0
    if (b !== 0) gs.push([42, real(s * b)])
  }
  return gs
}

function lwpolyline(c: Ctx, e: Polyline, handle: string | null): void {
  const { o } = c
  const w = lwWidths(e)
  head(c, 'LWPOLYLINE', e, handle, 'AcDbPolyline')
  o.int(90, e.pts.length >> 1)
  o.int(70, e.closed ? 1 : 0)
  if (w.constant !== 0) o.real(43, w.constant)
  for (const [code, v] of lwVertices(e, w.widths, 1)) o.str(code, v)
}

/** Vertex k's widths of its own (40, 41): those that differ from the polyline's defaults. */
function vertexWidths(e: Polyline, k: number): [number, string][] {
  const gs: [number, string][] = []
  if (!e.widths) return gs
  if (e.widths[2 * k] !== (e.startWidth ?? 0)) gs.push([40, real(e.widths[2 * k]!)])
  if (e.widths[2 * k + 1] !== (e.endWidth ?? 0)) gs.push([41, real(e.widths[2 * k + 1]!)])
  return gs
}

/** POLYLINE, its VERTEX records and the SEQEND, for files older than R14. */
function oldPolyline(c: Ctx, e: Polyline, handle: string | null): void {
  const { o } = c
  head(c, 'POLYLINE', e, handle, 'AcDb2dPolyline')
  o.int(66, 1)
  o.real(10, 0)
  o.real(20, 0)
  o.real(30, 0)
  o.int(70, e.closed ? 1 : 0)
  if (e.startWidth) o.real(40, e.startWidth)
  if (e.endWidth) o.real(41, e.endWidth)
  vertexRecords(c, o, e, handle, 1)
}

type Groups = [number, string][]

/**
 * A POLYLINE's VERTEX records and SEQEND, owned by the POLYLINE `owner`, x by s (±1, its OCS). Patched, the old
 * records are passed: vertex k keeps the handle and height of old vertex k while they last; the SEQEND stays.
 */
function vertexRecords(c: Ctx, o: Emitter, e: Polyline, owner: string | null, s: number, old: Groups[] = [], seqend: Groups | null = null): void {
  const { f } = c
  const layer = layerName(c, e)
  const value = (k: number, code: number): string | undefined => old[k]?.find((g) => g[0] === code)?.[1]
  const child = (type: string, handle: string | undefined): void => {
    o.str(0, type)
    const h = handle ?? (f.handles ? c.ids.take() : undefined)
    if (h) o.str(5, h)
    if (f.modern) {
      if (owner) o.str(330, owner)
      o.str(100, 'AcDbEntity')
    }
    o.str(8, layer)
  }
  for (let k = 0; k < e.pts.length >> 1; k++) {
    child('VERTEX', value(k, 5)?.trim())
    if (f.modern) {
      o.str(100, 'AcDbVertex')
      o.str(100, 'AcDb2dVertex')
    }
    o.real(10, s * e.pts[2 * k]!)
    o.real(20, e.pts[2 * k + 1]!)
    o.str(30, value(k, 30) ?? real(0))
    for (const [code, v] of vertexWidths(e, k)) o.str(code, v)
    const b = e.bulges?.[k] ?? 0
    if (b !== 0) o.real(42, s * b)
    o.int(70, 0)
  }
  if (!seqend) return child('SEQEND', undefined)
  o.str(0, 'SEQEND')
  for (const [code, v] of seqend) o.str(code, code === 8 ? layer : v)
}

const DXF_NAME: Readonly<Record<Entity['type'], string>> = {
  line: 'LINE', point: 'POINT', circle: 'CIRCLE', arc: 'ARC', polyline: 'LWPOLYLINE', opaque: '', ellipse: 'ELLIPSE', spline: 'SPLINE',
  insert: 'INSERT', text: 'TEXT', mtext: 'MTEXT',
}

/**
 * The record the file gave an edited entity, with its geometry, layer and color replaced: linetype, lineweight,
 * thickness, reactors and extended data survive the edit. Planar entities stay in the record's OCS. Null when the
 * record cannot take the new entity as is (another type, a missing group): it is then written fresh.
 */
function patched(c: Ctx, e: Entity, was: Entity, text: string, nl: string): string | null {
  const p = tokenize(text)
  // A polyline read from a POLYLINE stays one, whatever the version.
  const name = e.type === 'polyline' && p.is(0, 0, 'POLYLINE') ? 'POLYLINE' : DXF_NAME[e.type]
  if (!p.is(0, 0, name) || e.type === 'opaque') return null
  const gs: Groups = []
  for (let i = 1; i < p.length && p.code(i) !== 0; i++) gs.push([p.code(i), p.value(i)])
  const at = (code: number): number => gs.findIndex((g) => g[0] === code)
  const set = (code: number, v: string): boolean => {
    const k = at(code)
    if (k >= 0) gs[k]![1] = v
    return k >= 0
  }
  // ±Z extrusion, as the reader required for planar entities: -Z mirrors x and turns arcs the other way.
  const z = gs.find((g) => g[0] === 230)
  const s = z && Number(z[1]) < 0 ? -1 : 1
  let ok = true
  const put = (code: number, v: number): void => void (ok = set(code, real(v)) && ok)
  /**
   * A group a record may leave out at its default. Missing and needed, it goes after the last of `after` the record
   * has (AutoCAD's order); with none of them, the record is written fresh.
   */
  const opt = (code: number, v: string, atDefault: boolean, after: readonly number[] = []): void => {
    if (set(code, v) || atDefault) return
    for (const a of after) {
      const k = gs.findLastIndex((g) => g[0] === a)
      if (k >= 0) return void gs.splice(k + 1, 0, [code, v])
    }
    ok = false
  }
  switch (e.type) {
    case 'line':
      put(10, e.x0)
      put(20, e.y0)
      put(11, e.x1)
      put(21, e.y1)
      break
    case 'point':
      put(10, e.x)
      put(20, e.y)
      break
    case 'circle':
    case 'arc':
      put(10, s * e.cx)
      put(20, e.cy)
      put(40, e.r)
      if (e.type === 'arc') {
        put(50, s === 1 ? deg(e.a0) : deg(Math.PI - e.a1))
        put(51, s === 1 ? deg(e.a1) : deg(Math.PI - e.a0))
      }
      break
    case 'ellipse':
      // Centre and axis are in WCS; seen from -Z the parameter runs the other way.
      put(10, e.cx)
      put(20, e.cy)
      put(11, e.mx)
      put(21, e.my)
      put(40, e.ratio)
      if (e.t0 === e.t1) {
        put(41, s === 1 ? e.t0 : normAngle(-e.t0))
        put(42, (s === 1 ? e.t0 : normAngle(-e.t0)) + TAU)
      } else {
        put(41, s === 1 ? e.t0 : normAngle(-e.t1))
        put(42, s === 1 ? e.t1 : normAngle(-e.t0))
      }
      break
    case 'spline': {
      // New knots, weights and control points where the old ones were; fit data and tangents no longer match.
      const GEOMETRY = new Set([40, 41, 10, 20, 30, 11, 21, 31, 12, 22, 32, 13, 23, 33])
      const first = gs.findIndex((g) => GEOMETRY.has(g[0]))
      if (first < 0) return null
      const z = Number(gs.find((g) => g[0] === 30)?.[1] ?? 0)
      const rest = gs.filter((g) => !GEOMETRY.has(g[0]))
      const before = gs.slice(0, first).filter((g) => !GEOMETRY.has(g[0])).length
      gs.splice(0, gs.length, ...rest.slice(0, before), ...splineGroups(e, Number.isFinite(z) ? z : 0), ...rest.slice(before))
      ok = set(71, String(e.degree)) && set(72, String(e.knots.length)) && set(73, String(e.ctrl.length >> 1)) && ok
      if (at(74) >= 0) set(74, '0')
      const flags = Number(gs[at(70)]?.[1] ?? 0)
      if (at(70) >= 0) set(70, String((flags & ~(1 | 4)) | (e.closed ? 1 : 0) | (e.weights ? 4 : 0)))
      else ok = false
      break
    }
    case 'insert': {
      if (e.block.name !== (was as Insert).block.name) ok = set(2, e.block.name) && ok
      // Seen from -Z, x, the X scale, the turn and the column spacing are the other way round (as read).
      const groups: [number, string, string][] = [
        [10, real(s * e.x), ''], [20, real(e.y), ''], [41, real(s * e.sx), '1.0'], [42, real(e.sy), '1.0'],
        [50, real(e.rotation === 0 ? 0 : deg(s * e.rotation)), '0.0'], [70, String(e.cols), '1'], [71, String(e.rows), '1'],
        [44, real(s * e.dx), '0.0'], [45, real(e.dy), '0.0'],
      ]
      // A group the record lacks goes after the one before it in this list (or after 20, 30); a default needs none.
      let after = gs.findIndex((g) => g[0] === 30)
      for (const [code, v, none] of groups) {
        const k = at(code)
        if (k >= 0) {
          gs[k]![1] = v
          after = k
        } else if (code === 10 || code === 20) ok = false
        else if (v !== none) {
          if (after < 0) after = at(20)
          gs.splice(++after, 0, [code, v])
        }
      }
      break
    }
    case 'text':
      ok = patchText(gs, e, 73, c.f.modern) && ok
      break
    case 'mtext':
      put(10, e.x)
      put(20, e.y)
      put(40, e.height)
      // In AutoCAD's order: 10 40 41 71 72 3… 1 7 11 50 73 44.
      opt(41, real(e.width), e.width === 0, [40])
      opt(71, String(e.attachment), e.attachment === 1, [41, 40])
      // The direction where the record gives it, 11/21 winning over 50 (degrees) as on reading.
      if (at(11) >= 0) {
        put(11, Math.cos(e.rotation))
        put(21, Math.sin(e.rotation))
        set(50, real(deg(e.rotation)))
      } else opt(50, real(deg(e.rotation)), e.rotation === 0, [7, 1])
      opt(44, real(e.spacing), e.spacing === 1, [73, 50, 31, 7, 1])
      // The value is in chunks: a new one is written fresh.
      if (e.value !== (was as MText).value) ok = false
      break
    case 'polyline': {
      if (name === 'POLYLINE') {
        // The head here, the vertices after it. A curve or spline fit no longer matches them: plain, as shown.
        const setNumber = (code: number, v: number, text: string): void => {
          const k = at(code)
          if (k >= 0 && Number(gs[k]![1]) !== v) gs[k]![1] = text
          if (k >= 0 || v === 0) return
          // Missing, it goes after the groups AutoCAD puts before it: 66, 10, 20, 30, 39, 70, 40, 41.
          const after = Math.max(...[66, 10, 20, 30, 39, 70, 40, 41].map(at))
          if (after >= 0) gs.splice(after + 1, 0, [code, text])
          else ok = false
        }
        const flags = (Number(gs[at(70)]?.[1] ?? 0) & ~(1 | 2 | 4)) | (e.closed ? 1 : 0)
        setNumber(70, flags, String(flags))
        setNumber(40, e.startWidth ?? 0, real(e.startWidth ?? 0))
        setNumber(41, e.endWidth ?? 0, real(e.endWidth ?? 0))
        break
      }
      const VERTEX = new Set([10, 20, 40, 41, 42, 91])
      const first = gs.findIndex((g) => VERTEX.has(g[0]))
      if (first < 0) return null
      const rest = gs.filter((g) => !VERTEX.has(g[0]))
      const w = lwWidths(e)
      const vertices = lwVertices(e, w.widths, s)
      // The vertices go back where they were: after the groups that came before them.
      const before = gs.slice(0, first).filter((g) => !VERTEX.has(g[0])).length
      gs.splice(0, gs.length, ...rest.slice(0, before), ...vertices, ...rest.slice(before))
      ok = set(90, String(e.pts.length >> 1)) && ok
      const flags = Number(gs[at(70)]?.[1] ?? 0)
      if (at(70) >= 0) set(70, String((flags & ~1) | (e.closed ? 1 : 0)))
      else if (e.closed) return null
      // The constant width, as read when it did not change; after the flags (or the count) when the record had none.
      const constant = at(43)
      if (constant >= 0 && Number(gs[constant]![1]) !== w.constant) gs[constant]![1] = real(w.constant)
      else if (constant < 0 && w.constant !== 0) gs.splice((at(70) >= 0 ? at(70) : at(90)) + 1, 0, [43, real(w.constant)])
      break
    }
  }
  if (!ok || !set(8, layerName(c, e))) return null
  // The color: the new groups right after the layer, the old ones gone.
  const colors = emitter(nl)
  colorGroups(colors, c.f, e.color)
  const kept = gs.filter((g) => g[0] !== 62 && g[0] !== 420 && g[0] !== 430)
  const layerAt = kept.findIndex((g) => g[0] === 8)
  const out = emitter(nl)
  out.str(0, name)
  kept.forEach(([code, v], k) => {
    out.str(code, v)
    if (k === layerAt) out.raw(colors.text())
  })
  if (name === 'POLYLINE') {
    const old: Groups[] = []
    let seqend: Groups | null = null
    let i = 1
    while (i < p.length && p.code(i) !== 0) i++
    while (i < p.length) {
      const vertex = p.is(i, 0, 'VERTEX')
      const child: Groups = []
      for (i++; i < p.length && p.code(i) !== 0; i++) child.push([p.code(i), p.value(i)])
      if (vertex) old.push(child)
      else seqend = child
    }
    vertexRecords(c, out, e as Polyline, gs.find((g) => g[0] === 5)?.[1].trim() ?? null, s, old, seqend)
    return out.text()
  }
  if (e.type !== 'insert') return out.text()
  // Its attributes (ATTRIB … SEQEND) follow it: as the document has them, or, when it does not (one was not
  // understood), moved as the edit moved the insert.
  const old = insertAffines(was as Insert)[0]!
  const now = insertAffines(e)[0]!
  const move = compose(now, invert(old))
  const children: { name: string; gs: [number, string][] }[] = []
  let i = 1
  while (i < p.length && p.code(i) !== 0) i++
  while (i < p.length) {
    const name = p.value(i).trim()
    const child: [number, string][] = []
    for (i++; i < p.length && p.code(i) !== 0; i++) child.push([p.code(i), p.value(i)])
    children.push({ name, gs: child })
  }
  const attribs = e.attribs ?? []
  const modelled = attribs.length > 0 && children.filter((ch) => ch.name === 'ATTRIB').length === attribs.length
  let k = 0
  for (const { name, gs: child } of children) {
    out.str(0, name)
    if (name !== 'ATTRIB') {
      for (const [code, v] of child) out.str(code, v)
      continue
    }
    const a = modelled ? attribs[k++]! : null
    const flags = Number(child.find((g) => g[0] === 70)?.[1] ?? 0)
    const patchedChild = a && child.map((g): [number, string] => [g[0], g[1]])
    if (a && patchedChild && patchText(patchedChild, a, 74, c.f.modern) && patchedChild.some((g) => g[0] === 70) && patchedChild.some((g) => g[0] === 8)) {
      for (const g of patchedChild) {
        if (g[0] === 70) g[1] = String((flags & ~1) | (a.hidden ? 1 : 0))
        if (g[0] === 8) g[1] = fileLayer(c, a.layer)
      }
      const colors = emitter(nl)
      colorGroups(colors, c.f, a.color)
      const rest = patchedChild.filter((g) => g[0] !== 62 && g[0] !== 420 && g[0] !== 430)
      const layerAt = rest.findIndex((g) => g[0] === 8)
      rest.forEach(([code, v], n) => {
        out.str(code, v)
        if (n === layerAt) out.raw(colors.text())
      })
    } else for (const [code, v] of movedText(child, move)) out.str(code, v)
  }
  return out.text()
}

/**
 * Puts text e into the groups of a TEXT (vcode 73) or ATTRIB (vcode 74) record. A group left out at its default and
 * now needed goes in AutoCAD's order; false when there is no place for it.
 */
function patchText(gs: [number, string][], e: Omit<Text, 'id'>, vcode: 73 | 74, modern: boolean): boolean {
  let ok = true
  const at = (code: number): number => gs.findIndex((g) => g[0] === code)
  const set = (code: number, v: string): boolean => {
    const k = at(code)
    if (k >= 0) gs[k]![1] = v
    return k >= 0
  }
  const put = (code: number, v: number): void => void (ok = set(code, real(v)) && ok)
  const opt = (code: number, v: string, atDefault: boolean, after: readonly number[]): void => {
    if (set(code, v) || atDefault) return
    for (const a of after) {
      const k = gs.findLastIndex((g) => g[0] === a)
      if (k >= 0) return void gs.splice(k + 1, 0, [code, v])
    }
    ok = false
  }
  const [first, second] = textPoints(e)
  put(10, first.x)
  put(20, first.y)
  put(40, e.height)
  ok = set(1, e.value) && ok
  // In AutoCAD's order: 10 40 1 50 41 51 7 71 72 11; then TEXT's 73 after a second AcDbText marker, ATTRIB's 74
  // after its tag and flags.
  const order = [72, 71, 7, 51, 41, 50, 1, 40]
  opt(50, real(deg(e.rotation)), e.rotation === 0, order.slice(6))
  opt(41, real(e.widthFactor), e.widthFactor === 1, order.slice(5))
  opt(51, real(deg(e.oblique)), e.oblique === 0, order.slice(4))
  opt(71, String(textFlags(e)), textFlags(e) === 0, order.slice(2))
  opt(72, String(e.halign), e.halign === 0, order.slice(1))
  if (second) {
    opt(11, real(second.x), false, order)
    opt(21, real(second.y), false, [11])
    opt(31, '0.0', false, [21])
  }
  if (vcode === 74) {
    opt(74, String(e.valign), e.valign === 0, [73, 70, 2])
    return ok
  }
  if (!set(73, String(e.valign)) && e.valign !== 0) {
    const markers = gs.flatMap((g, k) => (g[0] === 100 && g[1].trim() === 'AcDbText' ? [k] : []))
    if (modern && markers.length > 1) gs.splice(markers.at(-1)! + 1, 0, [73, String(e.valign)])
    else {
      const k = [31, 21, 11, ...order].map((code) => gs.findLastIndex((g) => g[0] === code)).find((i) => i >= 0)
      if (k === undefined) return false
      gs.splice(k + 1, 0, ...((modern ? [[100, 'AcDbText'], [73, String(e.valign)]] : [[73, String(e.valign)]]) as [number, string][]))
    }
  }
  return ok
}

/** a after b. */
const compose = (a: Affine, b: Affine): Affine => ({
  a: a.a * b.a + a.c * b.b, b: a.b * b.a + a.d * b.b, c: a.a * b.c + a.c * b.d, d: a.b * b.c + a.d * b.d,
  e: a.a * b.e + a.c * b.f + a.e, f: a.b * b.e + a.d * b.f + a.f,
})

function invert(m: Affine): Affine {
  const det = affineDet(m)
  const a = m.d / det
  const b = -m.b / det
  const c = -m.c / det
  const d = m.a / det
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) }
}

/**
 * A text record's groups (an attribute) moved by m: its points, its height by the scale, its rotation by the turn.
 * A mirror leaves the rotation, so the text still reads left to right (AutoCAD's MIRRTEXT 0). In its OCS (±Z).
 */
function movedText(gs: [number, string][], m: Affine): [number, string][] {
  const z = gs.find((g) => g[0] === 230)
  const s = z && Number(z[1]) < 0 ? -1 : 1
  const det = affineDet(m)
  const out = gs.map((g): [number, string] => [g[0], g[1]])
  const at = (code: number): number => out.findIndex((g) => g[0] === code)
  for (const [cx, cy] of [[10, 20], [11, 21]] as const) {
    const i = at(cx)
    const j = at(cy)
    if (i < 0 || j < 0) continue
    const p = applyAffine(m, s * Number(out[i]![1]), Number(out[j]![1]))
    out[i]![1] = real(s * p.x)
    out[j]![1] = real(p.y)
  }
  const h = at(40)
  if (h >= 0) out[h]![1] = real(Number(out[h]![1]) * Math.sqrt(Math.abs(det)))
  const r = at(50)
  const turn = Math.atan2(m.b, m.a)
  if (det > 0 && turn !== 0) {
    const was = r >= 0 ? (s * Number(out[r]![1]) * Math.PI) / 180 : 0
    const v = real(deg(s * (was + turn)))
    if (r >= 0) out[r]![1] = v
    else if (at(40) >= 0) out.splice(at(40) + 1, 0, [50, v])
  }
  return out
}

/** Writes the document's entities; returns the spans of the file's records still there, as start, end pairs. */
function writeEntities(c: Ctx, source: DxfSource | null): number[] {
  const kept: number[] = []
  for (const e of c.doc.entities()) {
    const span = source?.loaded(e.id) ?? null
    if (span) kept.push(span.start, span.end)
    if (e.type === 'opaque') {
      c.o.raw(e.raw)
      continue
    }
    if (span && span.entity === e) {
      // As read: the exact text, so a file written back without edits is the file read.
      c.o.raw(source!.text.slice(span.start, span.end))
      continue
    }
    const handle = span ? source!.handleOf(e.id) : null
    // Patched with or without a handle: an R12 file may have none.
    if (span) {
      const p = patched(c, e, span.entity, source!.text.slice(span.start, span.end), source!.newline)
      if (p !== null) {
        c.o.raw(p)
        continue
      }
    }
    fresh(c, e, handle ?? (c.f.handles ? c.ids.take() : null))
  }
  return kept
}

/**
 * What the document no longer has of the file's ENTITIES, the records outside the spans still written: the handles
 * of erased entities and of their VERTEX, ATTRIB and SEQEND records, and of what they own by a hard pointer (360,
 * an extension dictionary).
 */
function erasedHandles(source: DxfSource, kept: number[]): Set<string> {
  const gone = new Set<string>()
  const s = source.sections.find((x) => x.name === 'ENTITIES')
  if (!s) return gone
  // In file order: undo brings an entity back at the end of the document.
  let order = Array.from({ length: kept.length >> 1 }, (_, k) => k)
  if (order.some((k) => k > 0 && kept[2 * k]! < kept[2 * k - 2]!)) order = order.sort((a, b) => kept[2 * a]! - kept[2 * b]!)
  let from = s.start
  const scan = (to: number): void => {
    if (to <= from) return
    const p = tokenize(source.text.slice(from, to))
    for (let i = 0; i < p.length; i++) {
      const v = p.value(i).trim()
      if ((p.code(i) === 5 || p.code(i) === 360) && v) gone.add(v)
    }
  }
  for (const k of order) {
    scan(kept[2 * k]!)
    from = Math.max(from, kept[2 * k + 1]!)
  }
  scan(s.end)
  return gone
}

/**
 * The OBJECTS section without what erased entities owned (gone: see erasedHandles), at any depth: an extension
 * dictionary, what it holds. GROUP (340) and SORTENTSTABLE (331 and its sort handle) lists leave the erased
 * entities out; a group they leave empty goes, and dictionary entries (3 and 350 or 360) of what went. The rest
 * as read.
 */
function writeObjects(text: string, gone: Set<string>): string {
  if (gone.size === 0) return text
  const p = tokenize(text)
  // Records between 0/SECTION and 0/ENDSEC: record r is [starts[r], starts[r + 1]).
  const starts: number[] = []
  for (let i = 0; i < p.length; i++) if (p.code(i) === 0) starts.push(i)
  const handles: string[] = []
  const owned = new Map<string, number[]>()
  const dropped = new Set<number>()
  for (let r = 1; r + 1 < starts.length; r++) {
    let handle = ''
    let owner = ''
    let reactors = false
    let members = 0
    let erased = 0
    for (let i = starts[r]! + 1; i < starts[r + 1]!; i++) {
      const code = p.code(i)
      // The owner is the 330 outside the 102 groups ({ACAD_REACTORS … }).
      if (code === 102) reactors = p.value(i).trim().startsWith('{')
      else if (code === 5 && !handle) handle = p.value(i).trim()
      else if (code === 330 && !reactors && !owner) owner = p.value(i).trim()
      else if (code === 340) {
        members++
        if (gone.has(p.value(i).trim())) erased++
      }
    }
    handles[r] = handle
    const list = owned.get(owner)
    if (list) list.push(r)
    else owned.set(owner, [r])
    if (gone.has(handle) || (erased > 0 && erased === members && p.is(starts[r]!, 0, 'GROUP'))) dropped.add(r)
  }
  // What a dropped object owns goes too, at any depth.
  const went = new Set(Array.from(dropped, (r) => handles[r]!).filter((h) => h !== ''))
  const queue = [...gone, ...went]
  while (queue.length > 0) {
    for (const r of owned.get(queue.pop()!) ?? []) {
      if (dropped.has(r)) continue
      dropped.add(r)
      if (handles[r] === '') continue
      went.add(handles[r]!)
      queue.push(handles[r]!)
    }
  }
  const parts = [text.slice(0, p.offset(starts[1]!))]
  for (let r = 1; r + 1 < starts.length; r++) {
    if (dropped.has(r)) continue
    const a = starts[r]!
    const b = starts[r + 1]!
    let from = p.offset(a)
    const list = p.is(a, 0, 'GROUP') ? 340 : p.is(a, 0, 'SORTENTSTABLE') ? 331 : -1
    const dictionary = p.is(a, 0, 'DICTIONARY')
    for (let i = a + 1; i < b; i++) {
      // The pairs left out: an erased member, with its sort handle; a dictionary entry, its name and handle.
      let n = 0
      if (p.code(i) === list && gone.has(p.value(i).trim())) n = list === 331 && p.code(i + 1) === 5 ? 2 : 1
      else if (dictionary && p.code(i) === 3 && (p.code(i + 1) === 350 || p.code(i + 1) === 360) && went.has(p.value(i + 1).trim())) n = 2
      if (n === 0) continue
      parts.push(text.slice(from, p.offset(i)))
      from = p.offset(i + n)
      i += n - 1
    }
    parts.push(text.slice(from, p.offset(b)))
  }
  parts.push(text.slice(p.offset(starts.at(-1)!)))
  return parts.join('')
}

/** A LAYER entry for a layer the file's table lacks. */
function freshLayer(o: Emitter, f: Flavor, l: Layer, handle: string | null, owner: string | null, plotStyle: string | null): void {
  o.str(0, 'LAYER')
  if (handle) o.str(5, handle)
  if (f.modern) {
    if (owner) o.str(330, owner)
    o.str(100, 'AcDbSymbolTableRecord')
    o.str(100, 'AcDbLayerTableRecord')
  }
  o.str(2, l.name)
  o.int(70, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0))
  const aci = l.color < TRUE_COLOR ? l.color : nearestAci(l.color & 0xffffff)
  // Frozen is not off: the color stays positive.
  o.int(62, l.visible || l.frozen ? aci : -aci)
  if (f.trueColor && l.color >= TRUE_COLOR) o.int(420, l.color & 0xffffff)
  o.str(6, f.modern ? 'Continuous' : 'CONTINUOUS')
  if (f.modern) {
    o.int(370, -3)
    if (plotStyle) o.str(390, plotStyle)
  }
}

/** A LAYER entry of the file with the color, visibility and lock of the document's layer. */
function patchedLayer(o: Emitter, f: Flavor, p: PairList, a: number, b: number, l: Layer): void {
  const was = layerEntry(p, a, b)
  const aci = l.color < TRUE_COLOR ? l.color : nearestAci(l.color & 0xffffff)
  // Hidden: frozen (flag 1) or off (negative color); frozen, it stays off too if it was. Shown: neither.
  const frozen = !l.visible && l.frozen === true
  const off = !l.visible && (!frozen || was.aci < 0)
  const flags = (was.flags & ~(1 | 4)) | (frozen ? 1 : 0) | (l.locked ? 4 : 0)
  o.str(0, p.value(a).trim())
  let colorDone = false
  const color = (): void => {
    if (colorDone) return
    colorDone = true
    o.int(62, off ? -aci : aci)
    if (f.trueColor && l.color >= TRUE_COLOR) o.int(420, l.color & 0xffffff)
  }
  for (let i = a + 1; i < b; i++) {
    const code = p.code(i)
    if (code === 62) color()
    else if (code === 420) continue
    else if (code === 70) o.int(70, flags)
    else {
      o.str(code, p.value(i))
      // After the flags, where AutoCAD puts it, if the entry had no color group.
      if (code === 2 && !layerHasGroup(p, a, b, 62)) color()
    }
  }
  color()
}

const layerHasGroup = (p: PairList, a: number, b: number, code: number): boolean => groupValue(p, a, b, code) !== null

const sameLayer = (l: Layer, e: { color: Color; visible: boolean; locked: boolean; frozen: boolean }): boolean =>
  l.color === e.color && l.visible === e.visible && l.locked === e.locked && (l.frozen === true) === e.frozen

/**
 * The TABLES section with the LAYER table matching the document: entries of unchanged layers as read, changed
 * ones patched, missing ones added. Layers go by their names in the file (fileLayer). The section's text as read
 * when nothing changed.
 */
function writeTables(c: Ctx, text: string, nl: string): string {
  const p = tokenize(text)
  const t = findTable(p, 0, p.length, 'LAYER')
  const layers = Array.from({ length: c.doc.layers.size }, (_, i) => ({ ...c.doc.layers.get(i)!, name: fileLayer(c, i) }))
  const byName = new Map<string, number>()
  t?.entries.forEach((a, k) => {
    if (!p.is(a, 0, 'LAYER')) return
    // The first entry of a name, as the reader took it.
    const key = layerEntry(p, a, entryEnd(t, k)).name.toLowerCase()
    if (!byName.has(key)) byName.set(key, k)
  })
  const entryOf = (l: Layer): number | undefined => byName.get(l.name.toLowerCase())
  const changed = layers.some((l) => {
    const k = entryOf(l)
    return k === undefined ? l.name !== '0' || !sameLayer(l, { color: 7, visible: true, locked: false, frozen: false }) : !sameLayer(l, layerEntry(p, t!.entries[k]!, entryEnd(t!, k)))
  })
  if (!changed) return text

  const o = emitter(nl)
  const owner = t ? groupValue(p, t.table, t.entries[0] ?? t.endtab, 5) : null
  let plotStyle: string | null = null
  if (t) for (const [k, a] of t.entries.entries()) plotStyle ??= groupValue(p, a, entryEnd(t, k), 390)
  const tableHandle = owner ?? (c.f.handles ? c.ids.take() : null)
  const rebuilt = (r: TableRange | null): void => {
    const patchedAt = new Map<number, Layer>()
    const extra: Layer[] = []
    for (const l of layers) {
      const k = entryOf(l)
      if (k === undefined) extra.push(l)
      else patchedAt.set(k, l)
    }
    o.str(0, 'TABLE')
    if (r) {
      // The table's own groups as read, its entry count updated.
      for (let i = r.table + 1; i < (r.entries[0] ?? r.endtab); i++) {
        if (p.code(i) === 70) o.int(70, r.entries.length + extra.length)
        else o.str(p.code(i), p.value(i))
      }
    } else {
      o.str(2, 'LAYER')
      if (tableHandle) o.str(5, tableHandle)
      if (c.f.modern) {
        o.str(330, '0')
        o.str(100, 'AcDbSymbolTable')
      }
      o.int(70, extra.length)
    }
    r?.entries.forEach((a, k) => {
      const l = patchedAt.get(k)
      const b = entryEnd(r, k)
      if (l && p.is(a, 0, 'LAYER') && !sameLayer(l, layerEntry(p, a, b))) patchedLayer(o, c.f, p, a, b, l)
      else o.raw(text.slice(p.offset(a), p.offset(b)))
    })
    for (const l of extra) freshLayer(o, c.f, l, c.f.handles ? c.ids.take() : null, tableHandle, plotStyle)
    o.str(0, 'ENDTAB')
  }
  if (t) {
    rebuilt(t)
    return text.slice(0, p.offset(t.table)) + o.text() + text.slice(p.offset(t.endtab + 1))
  }
  // No LAYER table: one goes in before ENDSEC.
  rebuilt(null)
  const endsec = p.length - 1
  return text.slice(0, p.offset(endsec)) + o.text() + text.slice(p.offset(endsec))
}

/** The HEADER section with the variable `name` set to value (added, with group `code`, when missing). */
function setHeaderVar(text: string, nl: string, name: string, code: number, value: string): string {
  const p = tokenize(text)
  for (let i = 0; i + 1 < p.length; i++) {
    if (!p.is(i, 9, name)) continue
    const start = p.offset(i + 1)
    const valueStart = text.indexOf('\n', start) + 1
    let valueEnd = text.indexOf('\n', valueStart)
    if (valueEnd < 0) valueEnd = text.length
    if (text.charCodeAt(valueEnd - 1) === 13) valueEnd--
    return text.slice(0, valueStart) + value + text.slice(valueEnd)
  }
  const endsec = p.length - 1
  return text.slice(0, p.offset(endsec)) + codeText(9) + nl + name + nl + codeText(code) + nl + value + nl + text.slice(p.offset(endsec))
}

/** The model space BLOCK_RECORD's handle, owner of the entities; null when the file has none. */
function modelSpace(source: DxfSource): string | null {
  const s = source.sections.find((x) => x.name === 'TABLES')
  if (!s) return null
  const p = tokenize(source.text.slice(s.start, s.end))
  const t = findTable(p, 0, p.length, 'BLOCK_RECORD')
  if (!t) return null
  for (const [k, a] of t.entries.entries()) {
    const b = entryEnd(t, k)
    if (groupValue(p, a, b, 2)?.toLowerCase() === '*model_space') return groupValue(p, a, b, 5)
  }
  return null
}

const section = (nl: string, name: string, body: string): string =>
  `${codeText(0)}${nl}SECTION${nl}${codeText(2)}${nl}${name}${nl}${body}${codeText(0)}${nl}ENDSEC${nl}`

/**
 * The document as DXF text. With the source it was read from, the file comes back as it was: every section but
 * ENTITIES as read (HEADER with a new $HANDSEED, TABLES with the LAYER table brought up to date), entities not
 * edited as read, edited ones patched in their own records, new ones in the file's version with handles past
 * the file's. Without a source, a new AC1015 file.
 */
export interface WriteOptions {
  /** The current layer's name, kept as $CLAYER. */
  currentLayer?: string
  /** TEXT's default height, kept as $TEXTSIZE. */
  textSize?: number
}

export function writeDxf(doc: Document, source?: DxfSource, opts: WriteOptions = {}): string {
  if (!source) return writeNew(doc, opts)
  const nl = source.newline
  const version = source.header.get('$ACADVER') ?? 'AC1009'
  const f = flavorOf(version, source.header.get('$HANDLING'))
  const ids = allocator(Math.max(source.handseed, 1))
  const ents = emitter(nl)
  const c: Ctx = { o: ents, f, ids, doc, owner: f.modern ? modelSpace(source) : null, names: source.layerNames }
  const kept = writeEntities(c, source)
  // What lies between sections (999 comments) goes back before the section that followed it.
  const sections = source.sections.map((s, k) => ({
    name: s.name, before: source.text.slice(source.sections[k - 1]?.end ?? 0, s.start), text: source.text.slice(s.start, s.end),
  }))
  const tablesAt = sections.findIndex((s) => s.name === 'TABLES')
  if (tablesAt >= 0) sections[tablesAt]!.text = writeTables(c, sections[tablesAt]!.text, nl)
  else {
    // A file without tables (some R12 writers): a LAYER table only when the layers need one.
    const bare = section(nl, 'TABLES', '')
    const tables = writeTables(c, bare, nl)
    if (tables !== bare) {
      // After HEADER and CLASSES, whatever follows them, if anything.
      const after = sections.findIndex((s) => s.name !== 'HEADER' && s.name !== 'CLASSES')
      sections.splice(after < 0 ? sections.length : after, 0, { name: 'TABLES', before: '', text: tables })
    }
  }
  const body = section(nl, 'ENTITIES', ents.text())
  const at = sections.findIndex((s) => s.name === 'ENTITIES')
  if (at >= 0) sections[at]!.text = body
  else {
    const objects = sections.findIndex((s) => s.name === 'OBJECTS' || s.name === 'THUMBNAILIMAGE' || s.name === 'ACDSDATA')
    sections.splice(objects >= 0 ? objects : sections.length, 0, { name: 'ENTITIES', before: '', text: body })
  }
  for (const s of sections) if (s.name === 'OBJECTS') s.text = writeObjects(s.text, erasedHandles(source, kept))
  const header = sections.find((s) => s.name === 'HEADER')
  if (header && f.handles) header.text = setHeaderVar(header.text, nl, '$HANDSEED', 5, ids.seed())
  if (header && opts.currentLayer !== undefined) {
    const current = doc.layers.indexOf(opts.currentLayer)
    const name = current >= 0 ? fileLayer(c, current) : opts.currentLayer
    if (name !== source.header.get('$CLAYER')) header.text = setHeaderVar(header.text, nl, '$CLAYER', 8, name)
  }
  if (header && opts.textSize !== undefined && opts.textSize !== textSizeOf(source.header)) {
    header.text = setHeaderVar(header.text, nl, '$TEXTSIZE', 40, real(opts.textSize))
  }
  return sections.map((s) => s.before + s.text).join('') + eof(source.text.slice(source.sections.at(-1)?.end ?? 0), nl)
}

/** The text after the last section as read, through its EOF line; an EOF line added when it has none. */
function eof(tail: string, nl: string): string {
  const p = tokenize(tail)
  for (let i = 0; i < p.length; i++) if (p.is(i, 0, 'EOF')) return tail.slice(0, p.offset(i + 1))
  return tail + codeText(0) + nl + 'EOF' + nl
}

function writeNew(doc: Document, opts: WriteOptions): string {
  const nl = '\r\n'
  const f = flavorOf('AC1015', undefined)
  const ids = allocator(FIRST_FREE_HANDLE)
  const o = emitter(nl)
  writeTemplate(
    o,
    {
      extents: docExtents(doc),
      currentLayer: opts.currentLayer ?? '0',
      textSize: opts.textSize ?? TEXTSIZE,
      layers(out) {
        for (let i = 0; i < doc.layers.size; i++) freshLayer(out, f, doc.layers.get(i)!, i === 0 ? H.layer0 : ids.take(), H.layerTable, H.plotStyleNormal)
        return doc.layers.size
      },
      entities(out) {
        writeEntities({ o: out, f, ids, doc, owner: H.modelRecord, names: [] }, null)
      },
      handseed: () => ids.seed(),
    },
    () => emitter(nl),
  )
  return o.text()
}
