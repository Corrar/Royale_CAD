import { TRUE_COLOR, aciRgb, type Color } from '../color'
import { docExtents, type Document, type Layer } from '../document'
import { typeOf } from '../entity/registry'
import { insertAffines } from '../entity/insert'
import type { Ellipse, Entity, Insert, Polyline, Spline } from '../entity/types'
import { affineDet, applyAffine, type Affine } from '../geom/vec'
import { TAU, normAngle } from '../geom/tol'
import type { DxfSource } from './reader'
import { entryEnd, findTable, groupValue, layerEntry, type TableRange } from './tables'
import { FIRST_FREE_HANDLE, H, writeTemplate } from './template'
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
}

const layerName = (c: Ctx, e: Entity): string => c.doc.layers.get(e.layer)!.name

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
      // A copy: the block reference alone (its attributes wait for text, T38). A grid is a MINSERT.
      const grid = e.cols > 1 || e.rows > 1
      head(c, 'INSERT', e, handle, grid ? 'AcDbMInsertBlock' : 'AcDbBlockReference')
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

function lwpolyline(c: Ctx, e: Polyline, handle: string | null): void {
  const { o } = c
  head(c, 'LWPOLYLINE', e, handle, 'AcDbPolyline')
  o.int(90, e.pts.length >> 1)
  o.int(70, e.closed ? 1 : 0)
  for (let k = 0; k < e.pts.length >> 1; k++) {
    o.real(10, e.pts[2 * k]!)
    o.real(20, e.pts[2 * k + 1]!)
    const b = e.bulges?.[k] ?? 0
    if (b !== 0) o.real(42, b)
  }
}

/** POLYLINE, its VERTEX records and the SEQEND, for files older than R14. */
function oldPolyline(c: Ctx, e: Polyline, handle: string | null): void {
  const { o, f } = c
  head(c, 'POLYLINE', e, handle, 'AcDb2dPolyline')
  o.int(66, 1)
  o.real(10, 0)
  o.real(20, 0)
  o.real(30, 0)
  o.int(70, e.closed ? 1 : 0)
  const child = (type: string): void => {
    o.str(0, type)
    if (f.handles) o.str(5, c.ids.take())
    if (f.modern) {
      if (handle) o.str(330, handle)
      o.str(100, 'AcDbEntity')
    }
    o.str(8, layerName(c, e))
  }
  for (let k = 0; k < e.pts.length >> 1; k++) {
    child('VERTEX')
    if (f.modern) {
      o.str(100, 'AcDbVertex')
      o.str(100, 'AcDb2dVertex')
    }
    o.real(10, e.pts[2 * k]!)
    o.real(20, e.pts[2 * k + 1]!)
    o.real(30, 0)
    const b = e.bulges?.[k] ?? 0
    if (b !== 0) o.real(42, b)
    o.int(70, 0)
  }
  child('SEQEND')
}

const DXF_NAME: Readonly<Record<Entity['type'], string>> = {
  line: 'LINE', point: 'POINT', circle: 'CIRCLE', arc: 'ARC', polyline: 'LWPOLYLINE', opaque: '', ellipse: 'ELLIPSE', spline: 'SPLINE',
  insert: 'INSERT', text: 'TEXT', mtext: 'MTEXT',
}

/**
 * The record the file gave an edited entity, with its geometry, layer and color replaced: linetype, lineweight,
 * thickness, reactors and extended data survive the edit. Planar entities stay in the record's OCS. Null when the
 * record cannot take the new entity as is (another type, a POLYLINE, a missing group): it is then written fresh.
 */
function patched(c: Ctx, e: Entity, was: Entity, text: string, nl: string): string | null {
  const p = tokenize(text)
  if (!p.is(0, 0, DXF_NAME[e.type]) || e.type === 'opaque') return null
  const gs: [number, string][] = []
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
    case 'polyline': {
      const VERTEX = new Set([10, 20, 40, 41, 42, 91])
      const first = gs.findIndex((g) => VERTEX.has(g[0]))
      if (first < 0) return null
      const rest = gs.filter((g) => !VERTEX.has(g[0]))
      const vertices: [number, string][] = []
      for (let k = 0; k < e.pts.length >> 1; k++) {
        vertices.push([10, real(s * e.pts[2 * k]!)], [20, real(e.pts[2 * k + 1]!)])
        const b = e.bulges?.[k] ?? 0
        if (b !== 0) vertices.push([42, real(s * b)])
      }
      // The vertices go back where they were: after the groups that came before them.
      const before = gs.slice(0, first).filter((g) => !VERTEX.has(g[0])).length
      gs.splice(0, gs.length, ...rest.slice(0, before), ...vertices, ...rest.slice(before))
      ok = set(90, String(e.pts.length >> 1)) && ok
      const flags = Number(gs[at(70)]?.[1] ?? 0)
      if (at(70) >= 0) set(70, String((flags & ~1) | (e.closed ? 1 : 0)))
      else if (e.closed) return null
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
  out.str(0, DXF_NAME[e.type])
  kept.forEach(([code, v], k) => {
    out.str(code, v)
    if (k === layerAt) out.raw(colors.text())
  })
  if (e.type !== 'insert') return out.text()
  // Its attributes (ATTRIB … SEQEND) follow it: moved as the edit moved the insert.
  const old = insertAffines(was as Insert)[0]!
  const now = insertAffines(e)[0]!
  const move = compose(now, invert(old))
  let i = 1
  while (i < p.length && p.code(i) !== 0) i++
  while (i < p.length) {
    const name = p.value(i).trim()
    const child: [number, string][] = []
    for (i++; i < p.length && p.code(i) !== 0; i++) child.push([p.code(i), p.value(i)])
    out.str(0, name)
    for (const [code, v] of name === 'ATTRIB' ? movedText(child, move) : child) out.str(code, v)
  }
  return out.text()
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

function writeEntities(c: Ctx, source: DxfSource | null): void {
  for (const e of c.doc.entities()) {
    if (e.type === 'opaque') {
      c.o.raw(e.raw)
      continue
    }
    const span = source?.loaded(e.id) ?? null
    if (span && span.entity === e) {
      // As read: the exact text, so a file written back without edits is the file read.
      c.o.raw(source!.text.slice(span.start, span.end))
      continue
    }
    const handle = span ? source!.handleOf(e.id) : null
    if (span && handle !== null) {
      const p = patched(c, e, span.entity, source!.text.slice(span.start, span.end), source!.newline)
      if (p !== null) {
        c.o.raw(p)
        continue
      }
    }
    fresh(c, e, handle ?? (c.f.handles ? c.ids.take() : null))
  }
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
  o.int(70, l.locked ? 4 : 0)
  const aci = l.color < TRUE_COLOR ? l.color : nearestAci(l.color & 0xffffff)
  o.int(62, l.visible ? aci : -aci)
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
  // Hidden: kept frozen if it was, otherwise off (negative color). Shown: neither.
  const frozen = !l.visible && (was.flags & 1) !== 0
  const flags = (was.flags & ~(1 | 4)) | (frozen ? 1 : 0) | (l.locked ? 4 : 0)
  o.str(0, p.value(a).trim())
  let colorDone = false
  const color = (): void => {
    if (colorDone) return
    colorDone = true
    o.int(62, l.visible || frozen ? aci : -aci)
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

const sameLayer = (l: Layer, e: { color: Color; visible: boolean; locked: boolean }): boolean =>
  l.color === e.color && l.visible === e.visible && l.locked === e.locked

/**
 * The TABLES section with the LAYER table matching the document: entries of unchanged layers as read, changed
 * ones patched, missing ones added. The section's text as read when nothing changed.
 */
function writeTables(c: Ctx, text: string, nl: string): string {
  const p = tokenize(text)
  const t = findTable(p, 0, p.length, 'LAYER')
  const layers = Array.from({ length: c.doc.layers.size }, (_, i) => c.doc.layers.get(i)!)
  const byName = new Map<string, number>()
  t?.entries.forEach((a, k) => {
    if (p.is(a, 0, 'LAYER')) byName.set(layerEntry(p, a, entryEnd(t, k)).name.toLowerCase(), k)
  })
  const entryOf = (l: Layer): number | undefined => byName.get(l.name.toLowerCase())
  const changed = layers.some((l) => {
    const k = entryOf(l)
    return k === undefined ? l.name !== '0' || !sameLayer(l, { color: 7, visible: true, locked: false }) : !sameLayer(l, layerEntry(p, t!.entries[k]!, entryEnd(t!, k)))
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
}

export function writeDxf(doc: Document, source?: DxfSource, opts: WriteOptions = {}): string {
  if (!source) return writeNew(doc, opts)
  const nl = source.newline
  const version = source.header.get('$ACADVER') ?? 'AC1009'
  const f = flavorOf(version, source.header.get('$HANDLING'))
  const ids = allocator(Math.max(source.handseed, 1))
  const ents = emitter(nl)
  const c: Ctx = { o: ents, f, ids, doc, owner: f.modern ? modelSpace(source) : null }
  writeEntities(c, source)
  const sections = source.sections.map((s) => ({ name: s.name, text: source.text.slice(s.start, s.end) }))
  const tablesAt = sections.findIndex((s) => s.name === 'TABLES')
  if (tablesAt >= 0) sections[tablesAt]!.text = writeTables(c, sections[tablesAt]!.text, nl)
  else {
    // A file without tables (some R12 writers): a LAYER table only when the layers need one.
    const bare = section(nl, 'TABLES', '')
    const tables = writeTables(c, bare, nl)
    if (tables !== bare) sections.splice(Math.max(0, sections.findIndex((s) => s.name !== 'HEADER' && s.name !== 'CLASSES')), 0, { name: 'TABLES', text: tables })
  }
  const body = section(nl, 'ENTITIES', ents.text())
  const at = sections.findIndex((s) => s.name === 'ENTITIES')
  if (at >= 0) sections[at]!.text = body
  else {
    const objects = sections.findIndex((s) => s.name === 'OBJECTS' || s.name === 'THUMBNAILIMAGE' || s.name === 'ACDSDATA')
    sections.splice(objects >= 0 ? objects : sections.length, 0, { name: 'ENTITIES', text: body })
  }
  const header = sections.find((s) => s.name === 'HEADER')
  if (header && f.handles) header.text = setHeaderVar(header.text, nl, '$HANDSEED', 5, ids.seed())
  if (header && opts.currentLayer !== undefined && opts.currentLayer !== source.header.get('$CLAYER')) {
    header.text = setHeaderVar(header.text, nl, '$CLAYER', 8, opts.currentLayer)
  }
  return sections.map((s) => s.text).join('') + codeText(0) + nl + 'EOF' + nl
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
      layers(out) {
        for (let i = 0; i < doc.layers.size; i++) freshLayer(out, f, doc.layers.get(i)!, i === 0 ? H.layer0 : ids.take(), H.layerTable, H.plotStyleNormal)
        return doc.layers.size
      },
      entities(out) {
        writeEntities({ o: out, f, ids, doc, owner: H.modelRecord }, null)
      },
      handseed: () => ids.seed(),
    },
    () => emitter(nl),
  )
  return o.text()
}
