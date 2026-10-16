import { TRUE_COLOR, type Color } from '../color'
import { createDocument, type Document, type Draft, type Layer } from '../document'
import { typeOf } from '../entity/registry'
import { BY_BLOCK, type Attrib, type Block, type BlockEntity, type Entity, type Insert, type Text } from '../entity/types'
import { nurbsProblem } from '../geom/curve'
import { TAU, eq, normAngle } from '../geom/tol'
import { bboxEmpty, bboxFinite } from '../geom/vec'
import { entryEnd, findTable, layerEntry } from './tables'
import { sections, tokenize, type PairList } from './tokenizer'

/** An entity as the file gave it, and the span [start, end) of the text it was read from. */
export interface LoadedSpan { readonly entity: Entity; readonly start: number; readonly end: number }

/** What the writer needs to give the file back as it was, beyond the document. */
export interface DxfSource {
  /** The decoded file. */
  readonly text: string
  /** The file's line break, kept when writing. */
  readonly newline: '\r\n' | '\n'
  /** Header variables by name ($ACADVER, $HANDSEED…), each as the value of its first group, trimmed. */
  readonly header: ReadonlyMap<string, string>
  /**
   * The first handle free for new objects: past $HANDSEED and past every handle (groups 5 and 105) in the file,
   * since some writers leave $HANDSEED behind.
   */
  readonly handseed: number
  /** Each section, spanning its text from the 0/SECTION line to past the 0/ENDSEC line. */
  readonly sections: readonly { readonly name: string; readonly start: number; readonly end: number }[]
  /** The name each layer read has in the file, by index: its own, unless the file's could not be a layer name. */
  readonly layerNames: readonly string[]
  /** The entity as read and the span of its text; null for an id the file did not give. */
  loaded(id: number): LoadedSpan | null
  /** The handle (group 5) the file gave the entity; null for later entities, or a file without handles. */
  handleOf(id: number): string | null
}

export interface DxfDrawing {
  readonly doc: Document
  readonly source: DxfSource
  /** What was read but not understood, for the user; empty when everything was. */
  readonly warnings: string[]
}

/** Why an entity is kept as is; `line` is where it went wrong, or null for the entity's first line. */
class Unsupported extends Error {
  readonly line: number | null
  constructor(message: string, line: number | null = null) {
    super(message)
    this.line = line
  }
}

/** A block that holds itself, at some depth: every insert of it is kept as is. */
class Cycle extends Unsupported {}

/** Pair i's value as a number; the value's line (2i + 2) in the error. */
function numberAt(pairs: PairList, i: number): number {
  const v = pairs.value(i)
  const x = Number(v)
  // Number('') and Number('  ') are 0; only then is the value worth a second look.
  if (Number.isFinite(x) && (x !== 0 || v.trim() !== '')) return x
  throw new Unsupported(`invalid number "${v.trim()}"`, 2 * i + 2)
}

/**
 * Whether flattening a spline, which its box needs, would pass the largest double: control points too far apart
 * make its tolerance infinite, and a weighted one past it makes a NaN that never flattens.
 */
function splineOverflows(ctrl: Float64Array, weights: Float64Array | null): boolean {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < ctrl.length; i += 2) {
    const x = ctrl[i]!
    const y = ctrl[i + 1]!
    const w = weights ? weights[i >> 1]! : 1
    if (!Number.isFinite(x * w) || !Number.isFinite(y * w)) return true
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return !Number.isFinite(Math.hypot(maxX - minX, maxY - minY))
}

/** The groups every entity may have. */
interface Head {
  handle: string | null
  layer: string
  aci: number | undefined
  trueColor: number | undefined
  paper: boolean
  /** Group 60 = 1: not drawn, like paper space. */
  invisible: boolean
  /** Extrusion direction (210/220/230), (0, 0, 1) when absent. */
  ex: number
  ey: number
  ez: number
}

/**
 * ACI 1–255, ByLayer (undefined), or a 420 true color. ByBlock is kept (BY_BLOCK): in a block it takes the insert's
 * color, in model space it shows as 7, and an edit writes it back as ByBlock.
 */
function colorOf(h: Head): Color | undefined {
  if (h.trueColor !== undefined) return TRUE_COLOR | (h.trueColor & 0xffffff)
  if (h.aci === undefined) return undefined
  const a = Math.abs(h.aci)
  if (a === 0) return BY_BLOCK
  return Number.isInteger(a) && a >= 1 && a <= 255 ? a : undefined
}

/** OCS to WCS for planar entities: 1 as is, -1 mirrored across the Y axis (extrusion (0, 0, -1)). */
function ocsSign(h: Head): 1 | -1 {
  const flat = Math.abs(h.ex) <= 1e-9 && Math.abs(h.ey) <= 1e-9
  if (flat && Math.abs(h.ez - 1) <= 1e-9) return 1
  if (flat && Math.abs(h.ez + 1) <= 1e-9) return -1
  throw new Unsupported(`extrusion (${h.ex}, ${h.ey}, ${h.ez}) is not supported`)
}

const DEG = Math.PI / 180

/** Records whose data continues in the entities after them, up to their SEQEND. */
const CHILDREN: Readonly<Record<string, string>> = { POLYLINE: 'VERTEX', INSERT: 'ATTRIB' }

/**
 * A draft before its layer and color are resolved; an insert names its block, which is found once the insert's
 * own head is read (finding it reads the block's entities with the same head).
 */
type Parsed = (Draft extends infer D ? (D extends Draft ? Omit<D, 'layer' | 'color'> : never) : never) | PendingInsert
/** Its attributes are null when one of them is not understood: the record then keeps them as they are. */
type PendingInsert = Omit<Draft<Insert>, 'layer' | 'color' | 'block' | 'attribs'> & { blockName: string; attribs: PendingAttrib[] | null }
type TextFields = Omit<Text, 'id' | 'layer' | 'color'>
/** An attribute before its layer and color are resolved. */
type PendingAttrib = TextFields & { tag: string; hidden: boolean; layerName: string; aci: number | undefined; trueColor: number | undefined }

/** The groups of a line of text as TEXT and ATTRIB give them. */
interface TextGroups {
  value: string
  x: number
  y: number
  x2: number
  y2: number
  height: number
  rotation: number
  widthFactor: number
  oblique: number
  flags: number
  halign: number
  valign: number
  style: string
}

const textGroups = (): TextGroups => ({ value: '', x: 0, y: 0, x2: NaN, y2: NaN, height: 0, rotation: 0, widthFactor: 1, oblique: 0, flags: 0, halign: 0, valign: 0, style: '' })

/**
 * A text placed by the point of its justification, which is 11 (10 being worked out from it) unless it is left on
 * the baseline; aligned and fit run from 10 to 11. Angles in degrees; the slant is kept within AutoCAD's ±85°.
 */
function textOf(t: TextGroups): TextFields {
  if (!(t.height > 0)) throw new Unsupported(`height ${t.height} is not positive`)
  const halign = Number.isInteger(t.halign) && t.halign >= 0 && t.halign <= 5 ? t.halign : 0
  const valign = Number.isInteger(t.valign) && t.valign >= 0 && t.valign <= 3 ? t.valign : 0
  const second = !Number.isNaN(t.x2) && !Number.isNaN(t.y2)
  const spanned = halign === 3 || halign === 5
  const [px, py] = (halign !== 0 || valign !== 0) && !spanned && second ? [t.x2, t.y2] : [t.x, t.y]
  const [qx, qy] = spanned && second ? [t.x2, t.y2] : [px, py]
  const slant = ((((t.oblique + 180) % 360) + 360) % 360) - 180
  return {
    type: 'text', value: t.value, x: px, y: py, x2: qx, y2: qy, height: t.height, rotation: normAngle(t.rotation * DEG),
    widthFactor: t.widthFactor > 0 ? t.widthFactor : 1, oblique: Math.max(-85, Math.min(85, slant)) * DEG,
    halign, valign, backward: (t.flags & 2) !== 0, upsideDown: (t.flags & 4) !== 0, ...(t.style && { style: t.style }),
  }
}

/**
 * A text in its OCS seen from -Z as one in the world, and back: x the other way, so it reads backward, its angles
 * the other way round, and an aligned or fit one between the same two points, its second first.
 */
export function seenFromBelow<T extends TextFields>(t: T): T {
  return {
    ...t, x: 0 - t.x2, y: t.y2, x2: 0 - t.x, y2: t.y, rotation: normAngle(0 - t.rotation), oblique: 0 - t.oblique, backward: !t.backward,
  }
}

/**
 * The entity readers of one file. They share one head, reset for each entity: a load of a million entities makes
 * no garbage per entity beyond the draft itself.
 */
function parser(pairs: PairList) {
  const codes = pairs.codes
  const head: Head = { handle: null, layer: '0', aci: undefined, trueColor: undefined, paper: false, invisible: false, ex: 0, ey: 0, ez: 1 }

  const num = (i: number): number => numberAt(pairs, i)

  /** Takes a group every entity may have into the head; false for the entity's own groups. */
  const common = (code: number, i: number): boolean => {
    switch (code) {
      case 5:
        head.handle = pairs.value(i).trim()
        return true
      case 8:
        head.layer = pairs.value(i).trim()
        return true
      case 62:
        head.aci = num(i)
        return true
      case 420:
        head.trueColor = num(i)
        return true
      case 67:
        head.paper = num(i) === 1
        return true
      case 60:
        head.invisible = num(i) === 1
        return true
      case 210:
        head.ex = num(i)
        return true
      case 220:
        head.ey = num(i)
        return true
      case 230:
        head.ez = num(i)
        return true
    }
    return false
  }

  const reset = (): void => {
    head.handle = null
    head.layer = '0'
    head.aci = undefined
    head.trueColor = undefined
    head.paper = false
    head.invisible = false
    head.ex = 0
    head.ey = 0
    head.ez = 1
  }

  /** The head alone, for an entity kept as is. */
  const scanHead = (a: number, b: number): void => {
    reset()
    for (let i = a + 1; i < b; i++) common(codes[i]!, i)
  }

  const line = (a: number, b: number): Parsed => {
    let x0 = 0
    let y0 = 0
    let x1 = 0
    let y1 = 0
    for (let i = a + 1; i < b; i++) {
      const c = codes[i]!
      if (c === 10) x0 = num(i)
      else if (c === 20) y0 = num(i)
      else if (c === 11) x1 = num(i)
      else if (c === 21) y1 = num(i)
      else common(c, i)
    }
    return { type: 'line', x0, y0, x1, y1 }
  }

  const point = (a: number, b: number): Parsed => {
    let x = 0
    let y = 0
    for (let i = a + 1; i < b; i++) {
      const c = codes[i]!
      if (c === 10) x = num(i)
      else if (c === 20) y = num(i)
      else common(c, i)
    }
    return { type: 'point', x, y }
  }

  const circleOrArc = (a: number, b: number, isArc: boolean): Parsed => {
    let cx = 0
    let cy = 0
    let r = 0
    let a0 = 0
    let a1 = 360
    for (let i = a + 1; i < b; i++) {
      const c = codes[i]!
      if (c === 10) cx = num(i)
      else if (c === 20) cy = num(i)
      else if (c === 40) r = num(i)
      else if (c === 50) a0 = num(i)
      else if (c === 51) a1 = num(i)
      else common(c, i)
    }
    if (!(r > 0)) throw new Unsupported(`radius ${r} is not positive`)
    const s = ocsSign(head)
    if (!isArc) return { type: 'circle', cx: s * cx, cy, r }
    // Mirrored, the run from a0 to a1 turns the other way: counter-clockwise it goes from 180° − a1 to 180° − a0.
    const b0 = s === 1 ? a0 * DEG : Math.PI - a1 * DEG
    const b1 = s === 1 ? a1 * DEG : Math.PI - a0 * DEG
    // An end whole turns past the start (30° to 390°) is a full circle, as ezdxf reads it: equal angles. Turned into
    // radians one by one, the two would land an ulp or two apart, a sliver.
    const turns = Math.round((a1 - a0) / 360)
    const full = turns !== 0 && eq(a1 - a0, 360 * turns)
    return { type: 'arc', cx: s * cx, cy, r, a0: normAngle(b0), a1: normAngle(full ? b0 : b1) }
  }

  /**
   * widths: each vertex's start and end width, null for none; w0 and w1: those of a piece without its own. The
   * polyline keeps widths only when one of them differs from w0 or w1.
   */
  const polylineOf = (xy: number[], bulges: number[], widths: number[] | null, w0: number, w1: number, closed: boolean): Parsed => {
    if (xy.length < 2) throw new Unsupported('it has no vertices')
    if (ocsSign(head) === -1) {
      for (let k = 0; k < xy.length; k += 2) xy[k] = -xy[k]!
      for (let k = 0; k < bulges.length; k++) bulges[k] = -bulges[k]!
    }
    const own = widths?.some((w, k) => w !== (k % 2 === 0 ? w0 : w1)) ? new Float64Array(widths) : null
    return {
      type: 'polyline', pts: new Float64Array(xy), bulges: bulges.some((v) => v !== 0) ? new Float64Array(bulges) : null, closed,
      ...(own && { widths: own }), ...(w0 !== 0 && { startWidth: w0 }), ...(w1 !== 0 && { endWidth: w1 }),
    }
  }

  const lwpolyline = (a: number, b: number): Parsed => {
    const xy: number[] = []
    const bulges: number[] = []
    const widths: number[] = []
    let flags = 0
    let constant = 0
    for (let i = a + 1; i < b; i++) {
      const c = codes[i]!
      if (c === 70) flags = num(i)
      else if (c === 10) {
        xy.push(num(i), 0)
        bulges.push(0)
        widths.push(0, 0)
      } else if (c === 20 && xy.length > 0) xy[xy.length - 1] = num(i)
      else if (c === 42 && bulges.length > 0) bulges[bulges.length - 1] = num(i)
      else if (c === 40 && widths.length > 0) widths[widths.length - 2] = num(i)
      else if (c === 41 && widths.length > 0) widths[widths.length - 1] = num(i)
      else if (c === 43) constant = num(i)
      else common(c, i)
    }
    // A constant width other than 0 shows over the vertices' own, as in AutoCAD.
    return polylineOf(xy, bulges, constant === 0 ? widths : null, constant, constant, (flags & 1) !== 0)
  }

  /** POLYLINE: the 2D kind, with its vertices (spline frame points left out); 3D polylines and meshes stay as is. */
  const polyline = (a: number, own: number, end: number): Parsed => {
    let flags = 0
    let w0 = 0
    let w1 = 0
    for (let i = a + 1; i < own; i++) {
      const c = codes[i]!
      if (c === 70) flags = num(i)
      else if (c === 40) w0 = num(i)
      else if (c === 41) w1 = num(i)
      else common(c, i)
    }
    if (flags & 8) throw new Unsupported('3D polylines are not supported')
    if (flags & (16 | 64)) throw new Unsupported('meshes are not supported')
    const xy: number[] = []
    const bulges: number[] = []
    const widths: number[] = []
    let i = own
    while (i < end && pairs.is(i, 0, 'VERTEX')) {
      let x = 0
      let y = 0
      let bulge = 0
      let vflags = 0
      // A vertex without widths of its own takes the polyline's defaults.
      let s = w0
      let t = w1
      for (i++; i < end && codes[i] !== 0; i++) {
        const c = codes[i]!
        if (c === 10) x = num(i)
        else if (c === 20) y = num(i)
        else if (c === 42) bulge = num(i)
        else if (c === 40) s = num(i)
        else if (c === 41) t = num(i)
        else if (c === 70) vflags = num(i)
      }
      if (!(vflags & 16)) {
        xy.push(x, y)
        bulges.push(bulge)
        widths.push(s, t)
      }
    }
    return polylineOf(xy, bulges, widths, w0, w1, (flags & 1) !== 0)
  }

  /** ELLIPSE: centre and major axis in WCS; the extrusion (±Z only) says which way the parameter turns. */
  const ellipse = (a: number, b: number): Parsed => {
    let cx = 0
    let cy = 0
    let mx = 0
    let my = 0
    let mz = 0
    let ratio = 1
    let t0 = 0
    let t1 = TAU
    for (let i = a + 1; i < b; i++) {
      const c = codes[i]!
      if (c === 10) cx = num(i)
      else if (c === 20) cy = num(i)
      else if (c === 11) mx = num(i)
      else if (c === 21) my = num(i)
      else if (c === 31) mz = num(i)
      else if (c === 40) ratio = num(i)
      else if (c === 41) t0 = num(i)
      else if (c === 42) t1 = num(i)
      else common(c, i)
    }
    const s = ocsSign(head)
    const major = Math.hypot(mx, my)
    if (!(major > 0) || Math.abs(mz) > 1e-9 * major) throw new Unsupported('its major axis is not in the XY plane')
    if (!(ratio > 0 && ratio <= 1)) throw new Unsupported(`axis ratio ${ratio} is not in (0, 1]`)
    // A whole turn, give or take rounding, is the whole ellipse: equal parameters.
    if (Math.abs(t1 - t0) > TAU - 1e-9 || normAngle(t0) === normAngle(t1)) return { type: 'ellipse', cx, cy, mx, my, ratio, t0: normAngle(s * t0), t1: normAngle(s * t0) }
    // Seen from -Z the parameter turns clockwise: counter-clockwise, the arc runs from -t1 to -t0.
    const [b0, b1] = s === 1 ? [t0, t1] : [-t1, -t0]
    return { type: 'ellipse', cx, cy, mx, my, ratio, t0: normAngle(b0), t1: normAngle(b1) }
  }

  /** SPLINE: control points in WCS, all at one height; one given by fit points alone stays as is. */
  const spline = (a: number, b: number): Parsed => {
    let flags = 0
    let degree = 3
    let fits = 0
    const knots: number[] = []
    const weights: number[] = []
    const xy: number[] = []
    const zs: number[] = []
    for (let i = a + 1; i < b; i++) {
      const c = codes[i]!
      if (c === 70) flags = num(i)
      else if (c === 71) degree = num(i)
      else if (c === 40) knots.push(num(i))
      else if (c === 41) weights.push(num(i))
      else if (c === 10) xy.push(num(i), 0)
      else if (c === 20 && xy.length > 0) xy[xy.length - 1] = num(i)
      else if (c === 30) zs.push(num(i))
      else if (c === 11) fits++
      else if (c !== 210 && c !== 220 && c !== 230) common(c, i) // the normal says nothing a flat curve needs
    }
    if (xy.length === 0) throw new Unsupported(fits > 0 ? 'splines given by fit points only are not supported' : 'it has no control points')
    if (zs.some((z) => z !== zs[0])) throw new Unsupported('3D splines are not supported')
    const w = weights.length > 0 && weights.some((v) => v !== 1) ? Float64Array.from(weights) : null
    const curve = { type: 'spline' as const, degree, knots: Float64Array.from(knots), ctrl: Float64Array.from(xy), weights: w, closed: (flags & 1) !== 0 }
    const problem = nurbsProblem(weights.length > 0 && !w ? { ...curve, weights } : curve)
    if (problem) throw new Unsupported(problem)
    if (splineOverflows(curve.ctrl, w)) throw new Unsupported('its geometry overflows')
    return curve
  }

  /**
   * INSERT (and a MINSERT grid): planar in its OCS, as an arc; the block is found by the caller. Its attributes are
   * the ATTRIB records from own to end.
   */
  const insert = (a: number, b: number, end: number): Parsed => {
    let blockName = ''
    let x = 0
    let y = 0
    let sx = 1
    let sy = 1
    let rotation = 0
    let cols = 1
    let rows = 1
    let dx = 0
    let dy = 0
    for (let i = a + 1; i < b; i++) {
      const c = codes[i]!
      if (c === 2) blockName = pairs.value(i).trim()
      else if (c === 10) x = num(i)
      else if (c === 20) y = num(i)
      else if (c === 41) sx = num(i)
      else if (c === 42) sy = num(i)
      else if (c === 50) rotation = num(i)
      else if (c === 70) cols = num(i)
      else if (c === 71) rows = num(i)
      else if (c === 44) dx = num(i)
      else if (c === 45) dy = num(i)
      else common(c, i)
    }
    if (!blockName) throw new Unsupported('it names no block')
    let attribs: PendingAttrib[] | null = []
    for (let i = b; i < end && pairs.is(i, 0, 'ATTRIB'); ) {
      let j = i + 1
      while (j < end && codes[j] !== 0) j++
      const at = attribAt(i, j)
      if (at === null) attribs = null
      else attribs?.push(at)
      i = j
    }
    const s = ocsSign(head)
    // Seen from -Z: diag(−1, 1)·T(x, y)·R(r)·S(sx, sy) = T(−x, y)·R(−r)·S(−sx, sy); the grid's columns flip too.
    return {
      type: 'insert', blockName, x: s * x, y, sx: s * sx, sy, rotation: normAngle(s * rotation * DEG),
      cols: Math.max(1, Math.trunc(cols)), rows: Math.max(1, Math.trunc(rows)), dx: s * dx, dy, attribs,
    }
  }

  /** SOLID: four corners in its OCS; without 13/23 the fourth is the third (a triangle). */
  const solid = (a: number, b: number): Parsed => {
    const v = [0, 0, 0, 0, 0, 0, NaN, NaN] // x0 y0 x1 y1 x2 y2 x3 y3
    for (let i = a + 1; i < b; i++) {
      const c = codes[i]!
      if (c >= 10 && c <= 13) v[2 * (c - 10)] = num(i)
      else if (c >= 20 && c <= 23) v[2 * (c - 20) + 1] = num(i)
      else common(c, i)
    }
    if (Number.isNaN(v[6])) v[6] = v[4]!
    if (Number.isNaN(v[7])) v[7] = v[5]!
    const s = ocsSign(head)
    return { type: 'solid', x0: s * v[0]!, y0: v[1]!, x1: s * v[2]!, y1: v[3]!, x2: s * v[4]!, y2: v[5]!, x3: s * v[6]!, y3: v[7]! }
  }

  /** Text is read seen from +Z only: from -Z it reads mirrored, which a text cannot say yet. */
  const upright = (): void => {
    if (ocsSign(head) === -1) throw new Unsupported('mirrored text (extrusion (0, 0, -1)) is not supported')
  }

  /** Takes a group of a line of text into t; vcode is the vertical alignment's (73 for TEXT, 74 for ATTRIB). */
  const textGroup = (t: TextGroups, c: number, i: number, vcode: number): boolean => {
    switch (c) {
      case 1:
        t.value = pairs.value(i)
        return true
      case 10:
        t.x = num(i)
        return true
      case 20:
        t.y = num(i)
        return true
      case 11:
        t.x2 = num(i)
        return true
      case 21:
        t.y2 = num(i)
        return true
      case 40:
        t.height = num(i)
        return true
      case 41:
        t.widthFactor = num(i)
        return true
      case 50:
        t.rotation = num(i)
        return true
      case 51:
        t.oblique = num(i)
        return true
      case 7:
        t.style = pairs.value(i).trim()
        return true
      case 71:
        t.flags = num(i)
        return true
      case 72:
        t.halign = num(i)
        return true
      case vcode:
        t.valign = num(i)
        return true
    }
    return false
  }

  /** TEXT, seen from +Z (textOf says where it goes). */
  const text = (a: number, b: number): Parsed => {
    const t = textGroups()
    for (let i = a + 1; i < b; i++) if (!textGroup(t, codes[i]!, i, 73)) common(codes[i]!, i)
    upright()
    return textOf(t)
  }

  /**
   * An ATTRIB record [a, b) with its own layer and color (the insert's head stays as it is); null when it is not
   * understood. A multiline one's embedded MTEXT, after 101, is left out: the line of text has the value. Seen from
   * -Z, it is mirrored into the world.
   */
  const attribAt = (a: number, b: number): PendingAttrib | null => {
    const t = textGroups()
    // Past its 100 AcDbAttribute marker, R2018 repeats 72 and 11 and has 71 as the attribute type (1 single line,
    // 2 multiline): the text's own groups are those of AcDbText.
    let attribute = false
    let tag = ''
    let flags = 0
    let invisible = false
    let layerName = '0'
    let aci: number | undefined
    let trueColor: number | undefined
    let ex = 0
    let ey = 0
    let ez = 1
    try {
      for (let i = a + 1; i < b; i++) {
        const c = codes[i]!
        if (c === 101) break
        if (c === 100) attribute = pairs.value(i).trim() === 'AcDbAttribute'
        if (attribute && (c === 71 || c === 72 || c === 11 || c === 21 || c === 31)) continue
        if (textGroup(t, c, i, 74)) continue
        if (c === 2) tag = pairs.value(i).trim()
        else if (c === 70) flags = num(i)
        else if (c === 60) invisible = num(i) === 1
        else if (c === 8) layerName = pairs.value(i).trim()
        else if (c === 62) aci = num(i)
        else if (c === 420) trueColor = num(i)
        else if (c === 210) ex = num(i)
        else if (c === 220) ey = num(i)
        else if (c === 230) ez = num(i)
      }
      if (!(Math.abs(ex) <= 1e-9 && Math.abs(ey) <= 1e-9 && Math.abs(Math.abs(ez) - 1) <= 1e-9)) return null
      const text = ez < 0 ? seenFromBelow(textOf(t)) : textOf(t)
      return { ...text, tag, hidden: (flags & 1) !== 0 || invisible, layerName, aci, trueColor }
    } catch (error) {
      if (error instanceof Unsupported) return null
      throw error
    }
  }

  /**
   * MTEXT: its value is the 3 chunks then the 1 group, codes kept. The direction 11/21 (WCS), when given, wins
   * over the rotation 50 (degrees, as AutoCAD writes it). Its columns, after 101, are left out.
   */
  const mtext = (a: number, b: number): Parsed => {
    const chunks: string[] = []
    let last = ''
    let x = 0
    let y = 0
    let dx = 0
    let dy = 0
    let height = 0
    let width = 0
    let attachment = 1
    let rotation = 0
    let spacing = 1
    let style = ''
    for (let i = a + 1; i < b; i++) {
      const c = codes[i]!
      // R2018's columns: an embedded object, its own direction, insert and sizes.
      if (c === 101) break
      if (c === 1) last = pairs.value(i)
      else if (c === 3) chunks.push(pairs.value(i))
      else if (c === 10) x = num(i)
      else if (c === 20) y = num(i)
      else if (c === 11) dx = num(i)
      else if (c === 21) dy = num(i)
      else if (c === 40) height = num(i)
      else if (c === 41) width = num(i)
      else if (c === 71) attachment = num(i)
      else if (c === 50) rotation = num(i)
      else if (c === 44) spacing = num(i)
      else if (c === 7) style = pairs.value(i).trim()
      else common(c, i)
    }
    upright()
    if (!(height > 0)) throw new Unsupported(`height ${height} is not positive`)
    return {
      type: 'mtext', value: chunks.join('') + last, x, y, height, width: width > 0 ? width : 0,
      attachment: Number.isInteger(attachment) && attachment >= 1 && attachment <= 9 ? attachment : 1,
      rotation: normAngle(dx !== 0 || dy !== 0 ? Math.atan2(dy, dx) : rotation * DEG),
      spacing: spacing > 0 ? spacing : 1, ...(style && { style }),
    }
  }

  /** The entity [a, end) (its own groups end at own) as understood; null for a type it does not read. */
  const read = (name: string, a: number, own: number, end: number): Parsed | null => {
    reset()
    switch (name) {
      case 'LINE':
        return line(a, own)
      case 'POINT':
        return point(a, own)
      case 'CIRCLE':
        return circleOrArc(a, own, false)
      case 'ARC':
        return circleOrArc(a, own, true)
      case 'LWPOLYLINE':
        return lwpolyline(a, own)
      case 'POLYLINE':
        return polyline(a, own, end)
      case 'ELLIPSE':
        return ellipse(a, own)
      case 'SPLINE':
        return spline(a, own)
      case 'INSERT':
        return insert(a, own, end)
      case 'TEXT':
        return text(a, own)
      case 'MTEXT':
        return mtext(a, own)
      case 'SOLID':
        return solid(a, own)
    }
    return null
  }

  return { head, read, scanHead }
}

/** The entities of the ENTITIES section as pair ranges: entity k is [starts[k], ends[k]), its own groups end at owns[k]. */
function records(pairs: PairList, start: number, end: number): { n: number; starts: Int32Array; owns: Int32Array; ends: Int32Array } {
  const codes = pairs.codes
  let n = 0
  for (let i = start; i < end; i++) if (codes[i] === 0) n++
  const starts = new Int32Array(n)
  const owns = new Int32Array(n)
  const ends = new Int32Array(n)
  const next = (i: number): number => {
    let j = i + 1
    while (j < end && codes[j] !== 0) j++
    return j
  }
  let k = 0
  // Anything before the first 0 pair is not an entity; skip it.
  let i = start
  while (i < end && codes[i] !== 0) i++
  while (i < end) {
    const own = next(i)
    let j = own
    const child = CHILDREN[pairs.value(i).trim()]
    if (child) {
      // VERTEX or ATTRIB records, then the SEQEND that closes them.
      while (j < end && pairs.is(j, 0, child)) j = next(j)
      if (j < end && pairs.is(j, 0, 'SEQEND')) j = next(j)
    }
    starts[k] = i
    owns[k] = own
    ends[k] = j
    k++
    i = j
  }
  return { n: k, starts, owns, ends }
}

/** Layer names AutoCAD refuses; the document refuses them too. */
const INVALID_NAME = /[<>/\\":;?*|,=`]/g

/** \U+XXXX: how a file before AC1021 (and encodeDxf) writes a character its code page lacks. */
const ESCAPED = /\\[Uu]\+([0-9A-Fa-f]{4})/g
const unescaped = (name: string): string => name.replace(ESCAPED, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))

interface Layers {
  /** The layer index for a name the file uses, created with defaults when the table lacks it. */
  of(name: string): number
  /**
   * Once every name the file uses is known: the layers, layer 0 first, and the name each has in the file. A name
   * a layer cannot have (an xref layer's |, a /) gives way to one no other layer has; a valid name never changes.
   */
  done(): { list: Layer[]; names: string[] }
}

function layerTable(pairs: PairList, start: number, end: number, warnings: string[]): Layers {
  const list: Layer[] = [{ name: '0', color: 7, visible: true, locked: false }]
  const names = ['0']
  const byName = new Map<string, number>()
  const add = (name: string, l: Omit<Layer, 'name'>): number => {
    const key = name.toLowerCase()
    const known = byName.get(key)
    if (known !== undefined) return known
    const index = key === '0' ? 0 : list.length
    list[index] = { name, ...l }
    names[index] = name
    byName.set(key, index)
    return index
  }
  const t = findTable(pairs, start, end, 'LAYER')
  if (t) {
    t.entries.forEach((a, k) => {
      if (!pairs.is(a, 0, 'LAYER')) return
      const l = layerEntry(pairs, a, entryEnd(t, k))
      if (l.name !== '') add(l.name, { color: l.color, visible: l.visible, locked: l.locked, ...(l.frozen && { frozen: true }) })
    })
  }
  return {
    of: (name) => add(name, { color: 7, visible: true, locked: false }),
    done() {
      const clean = (name: string): string => name.replace(INVALID_NAME, '_').trim() || '_'
      // Every valid name is spoken for before any other is changed, even one only an entity met later uses.
      const taken = new Set(names.filter((n) => clean(n) === n).map((n) => n.toLowerCase()))
      const renamed: string[] = []
      names.forEach((name, i) => {
        if (clean(name) === name) return
        // "\U+0394-COTA" is Δ-COTA, as AutoCAD shows it: the backslash is the file's, not the name's.
        const read = unescaped(name)
        let to = clean(read)
        const valid = to === read
        while (taken.has(to.toLowerCase())) to += '_'
        taken.add(to.toLowerCase())
        list[i] = { ...list[i]!, name: to }
        if (to !== read) renamed.push(`Layer "${read}" renamed "${to}": ${valid ? 'another layer has that name' : 'its name has characters layers cannot have'}.`)
      })
      // Ahead of the entities' warnings, as the table comes before them.
      warnings.unshift(...renamed)
      return { list, names }
    },
  }
}

function readHeader(pairs: PairList, start: number, end: number): Map<string, string> {
  const header = new Map<string, string>()
  for (let i = start; i + 1 < end; i++) {
    if (pairs.code(i) !== 9) continue
    const name = pairs.value(i).trim()
    if (!header.has(name) && pairs.code(i + 1) !== 9) header.set(name, pairs.value(i + 1).trim())
  }
  return header
}

/**
 * A DXF read into plain data, as a worker can hand it over: the layers, the drafts in file order with the span of
 * text each came from, and what the writer needs of the file.
 */
export interface ParsedDxf {
  readonly text: string
  readonly newline: '\r\n' | '\n'
  readonly header: ReadonlyMap<string, string>
  readonly handseed: number
  readonly sections: readonly { readonly name: string; readonly start: number; readonly end: number }[]
  /** Layer 0 first. */
  readonly layers: readonly Layer[]
  /** The name layer k has in the file: layers[k].name, unless the file's could not be a layer name. */
  readonly layerNames: readonly string[]
  readonly drafts: readonly Draft[]
  /** Draft k came from the text [spans[2k], spans[2k + 1]). */
  readonly spans: Uint32Array
  readonly warnings: readonly string[]
}

/** A BLOCK of the BLOCKS section: its name and base point, and the pairs [start, end) of its entities. */
interface BlockDef { name: string; x: number; y: number; external: boolean; start: number; end: number }

/** The blocks defined in the BLOCKS section, by upper-case name; model and paper space are not blocks to show. */
function blockDefs(pairs: PairList, start: number, end: number): Map<string, BlockDef> {
  const defs = new Map<string, BlockDef>()
  for (let i = start; i < end; i++) {
    if (!pairs.is(i, 0, 'BLOCK')) continue
    const def: BlockDef = { name: '', x: 0, y: 0, external: false, start: i + 1, end: i + 1 }
    let j = i + 1
    for (; j < end && pairs.code(j) !== 0; j++) {
      const c = pairs.code(j)
      if (c === 2) def.name = pairs.value(j).trim()
      else if (c === 10) def.x = numberAt(pairs, j)
      else if (c === 20) def.y = numberAt(pairs, j)
      else if (c === 70) def.external = (numberAt(pairs, j) & 4) !== 0
    }
    def.start = j
    while (j < end && !pairs.is(j, 0, 'ENDBLK')) j++
    def.end = j
    i = j
    const key = def.name.toUpperCase()
    if (def.name && !key.startsWith('*MODEL_SPACE') && !key.startsWith('*PAPER_SPACE')) defs.set(key, def)
  }
  return defs
}

/** Whether d is a polyline with a width (every width field is absent when 0). */
const isWide = (d: Draft): boolean => d.type === 'polyline' && (d.widths !== undefined || d.startWidth !== undefined || d.endWidth !== undefined)

/** How often, in entities, parseDxf reports progress. */
const PROGRESS_EVERY = 16384

/**
 * Reads an ASCII DXF: HEADER (kept whole, read for a few variables), the LAYER table, and the model space
 * entities of the ENTITIES section. LINE, POINT, CIRCLE, ARC, LWPOLYLINE and 2D POLYLINE become drafts;
 * everything else, and what these hold that the document cannot (paper space, invisible, a tilted extrusion, a
 * bad number), stays as Opaque, written back unchanged. Throws DxfError for a malformed file. `progress` hears
 * the fraction done, now and then.
 */
export function parseDxf(text: string, progress?: (done: number) => void): ParsedDxf {
  const pairs = tokenize(text)
  progress?.(0.3)
  const ranges = sections(pairs)
  const warnings: string[] = []
  const find = (name: string) => ranges.find((s) => s.name === name)

  const hs = find('HEADER')
  const header = hs ? readHeader(pairs, hs.start, hs.end) : new Map<string, string>()
  const tables = find('TABLES')
  const layers = layerTable(pairs, tables?.start ?? 0, tables?.end ?? 0, warnings)

  const ents = find('ENTITIES')
  const recs = ents ? records(pairs, ents.start, ents.end) : { n: 0, starts: new Int32Array(0), owns: new Int32Array(0), ends: new Int32Array(0) }
  const { head, read, scanHead } = parser(pairs)

  // Blocks, read when an insert first needs one: name (any case) to definition, then to the block made of it.
  const bs = find('BLOCKS')
  const defs = bs ? blockDefs(pairs, bs.start, bs.end) : new Map<string, BlockDef>()
  const made = new Map<string, Block | null>() // null: being read
  let blockKept = 0
  // Polylines with a width, drawn thin for now.
  let wide = 0
  const blockOf = (name: string): Block => {
    const key = name.toUpperCase()
    const done = made.get(key)
    if (done === null) throw new Cycle(`block ${name} holds itself`)
    if (done) return done
    const def = defs.get(key)
    if (!def) throw new Unsupported(`block ${name} is not defined`)
    if (def.external) throw new Unsupported(`block ${name} is an external reference, which is not supported`)
    made.set(key, null)
    const entities: BlockEntity[] = []
    const rs = records(pairs, def.start, def.end)
    for (let k = 0; k < rs.n; k++) {
      const a = rs.starts[k]!
      const name = pairs.value(a).trim()
      // An attribute definition never shows in an insert: its values (ATTRIB) do.
      if (name === 'ATTDEF') continue
      try {
        const d = resolve(read(name, a, rs.owns[k]!, rs.ends[k]!))
        if (d) entities.push(d as BlockEntity)
        else blockKept++
        if (d && isWide(d)) wide++
      } catch (error) {
        if (!(error instanceof Unsupported) || error instanceof Cycle) throw error
        blockKept++
      }
    }
    const block: Block = { name: def.name, x: def.x, y: def.y, entities }
    made.set(key, block)
    return block
  }
  /**
   * A parsed entity with its layer and color from the head, and an insert's block found: null when it is not
   * drawn (a type not read, paper space, invisible). Throws Unsupported as the parsers do, and for what the
   * document would refuse.
   */
  function resolve(parsed: Parsed | null): Draft | null {
    if (!parsed || head.paper || head.invisible) return null
    const layer = layers.of(head.layer)
    const color = colorOf(head)
    let d: Draft
    if (parsed.type === 'insert') {
      const { blockName, attribs, ...rest } = parsed as PendingInsert
      const shown = attribs?.map(({ layerName, aci, trueColor, ...a }): Attrib => {
        const c = colorOf({ ...head, aci, trueColor })
        return { ...a, layer: layers.of(layerName), ...(c !== undefined && { color: c }) }
      })
      d = { ...rest, layer, block: blockOf(blockName), ...(shown && shown.length > 0 && { attribs: shown }) }
    } else d = { ...(parsed as Omit<Draft, 'layer'>), layer } as Draft
    if (color !== undefined) (d as { color?: Color }).color = color
    // Finite numbers can still make a box past the largest double (a radius of 1e308), which the document refuses.
    const t = typeOf(d as Entity)
    const problem = t.validate?.(d as Entity)
    if (problem) throw new Unsupported(problem)
    const b = t.bbox(d as Entity)
    if (!(bboxFinite(b) || bboxEmpty(b))) throw new Unsupported('its geometry overflows')
    return d
  }
  const drafts: Draft[] = new Array(recs.n)
  const spans = new Uint32Array(2 * recs.n)
  const kept = new Map<string, number>()
  const keep = (key: string): void => void kept.set(key, (kept.get(key) ?? 0) + 1)
  for (let k = 0; k < recs.n; k++) {
    if (progress && k % PROGRESS_EVERY === 0) progress(0.3 + (0.7 * k) / recs.n)
    const a = recs.starts[k]!
    const own = recs.owns[k]!
    const end = recs.ends[k]!
    const name = pairs.value(a).trim()
    let draft: Draft | null = null
    try {
      const parsed = read(name, a, own, end)
      if (!parsed) keep(name)
      else if (head.paper) keep('paper space')
      else if (head.invisible) keep('invisible')
      else draft = resolve(parsed)
      if (draft && isWide(draft)) wide++
      if (draft?.type === 'insert' && (parsed as PendingInsert).attribs === null) {
        warnings.push(`line ${2 * a + 1}: INSERT keeps its attributes as is, not shown: one is not understood.`)
      }
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error
      warnings.push(`line ${error.line ?? 2 * a + 1}: ${name} kept as is: ${error.message}.`)
    }
    spans[2 * k] = pairs.offset(a)
    spans[2 * k + 1] = pairs.offset(end)
    if (!draft) {
      // Kept as is: its head read leniently, for the layer and color it shows under.
      try {
        scanHead(a, own)
      } catch {
        // A bad color or flag: what was read so far stands.
      }
      const color = colorOf(head)
      draft = { type: 'opaque', layer: layers.of(head.layer), name, raw: text.slice(spans[2 * k]!, spans[2 * k + 1]!) }
      if (color !== undefined) (draft as { color?: Color }).color = color
    }
    drafts[k] = draft
  }
  const { list: layerList, names: layerNames } = layers.done()
  for (const [key, n] of kept) {
    const entities = n === 1 ? 'entity' : 'entities'
    if (key === 'paper space') warnings.push(`${n} ${entities} in paper space kept as is (not drawn).`)
    else if (key === 'invisible') warnings.push(`${n} invisible ${entities} kept as is (not drawn).`)
    else warnings.push(`${n} ${key} kept as is (not drawn).`)
  }
  if (blockKept > 0) warnings.push(`${blockKept} ${blockKept === 1 ? 'entity' : 'entities'} in blocks not drawn.`)
  if (wide > 0) warnings.push(`${wide} ${wide === 1 ? 'polyline' : 'polylines'} with width drawn thin (their widths are kept).`)

  let handseed = parseInt(header.get('$HANDSEED') ?? '0', 16) || 0
  const codes = pairs.codes
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] !== 5 && codes[i] !== 105) continue
    // In the HEADER, group 5 is the value of $HANDSEED itself.
    if (hs && i >= hs.start && i < hs.end) continue
    const h = parseInt(pairs.value(i).trim(), 16)
    if (h >= handseed) handseed = h + 1
  }
  progress?.(1)

  const lf = text.indexOf('\n')
  return {
    text,
    newline: lf > 0 && text.charCodeAt(lf - 1) === 13 ? '\r\n' : '\n',
    header,
    handseed,
    sections: ranges.map((s) => ({ name: s.name, start: pairs.offset(s.section), end: pairs.offset(s.end + 1) })),
    layers: layerList,
    layerNames,
    drafts,
    spans,
    warnings,
  }
}

/** What parseDxf gives besides the drafts. */
export type ParsedMeta = Omit<ParsedDxf, 'drafts'>

/** Entities first … first + n - 1 came from drafts k … k + n - 1 of the file. */
interface Run { first: number; k: number; n: number }

/** What the writer needs of a file whose drafts became `originals`, in runs of consecutive ids. */
function drawingOf(doc: Document, meta: ParsedMeta, originals: readonly Entity[], runs: readonly Run[]): DxfDrawing {
  const { spans } = meta
  const loaded = (id: number): LoadedSpan | null => {
    // The last run that begins at or before id.
    let lo = 0
    let hi = runs.length - 1
    let r = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (runs[mid]!.first <= id) {
        r = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    const run = runs[r]
    if (!run || id - run.first >= run.n) return null
    const k = run.k + id - run.first
    return { entity: originals[k]!, start: spans[2 * k]!, end: spans[2 * k + 1]! }
  }
  return {
    doc,
    warnings: [...meta.warnings],
    source: {
      // Read when first needed (a save, a handle): the app may decode the file's text only then.
      get text() {
        return meta.text
      },
      newline: meta.newline,
      header: meta.header,
      handseed: meta.handseed,
      sections: meta.sections,
      layerNames: meta.layerNames,
      loaded,
      handleOf(id) {
        const span = loaded(id)
        if (!span) return null
        const own = tokenize(meta.text.slice(span.start, span.end))
        for (let i = 1; i < own.length && own.code(i) !== 0; i++) if (own.code(i) === 5) return own.value(i).trim()
        return null
      },
    },
  }
}

/**
 * Puts a parsed file in place of doc's drawing in slices, so a big file never holds the thread for long: the
 * file's layers at once (Document.replace), then add() for each slice of drafts in file order (Document.append),
 * then finish() for what the writer needs. Entities added by others between slices have no source. None of it
 * can be undone; a bad draft throws with the slices before it in.
 */
export function loader(doc: Document, meta: ParsedMeta): { add(drafts: readonly Draft[]): void; finish(): DxfDrawing } {
  doc.replace(meta.layers, [])
  const originals: Entity[] = []
  const runs: Run[] = []
  return {
    add(drafts) {
      const added = doc.append(drafts)
      if (added.length > 0) runs.push({ first: added[0]!.id, k: originals.length, n: added.length })
      for (const e of added) originals.push(e)
    },
    finish: () => drawingOf(doc, meta, originals, runs),
  }
}

/**
 * Puts a parsed file in place of doc's drawing at once and returns what the writer needs of it. A bad draft
 * throws and changes nothing.
 */
export function drawingFrom(doc: Document, parsed: ParsedDxf): DxfDrawing {
  const originals = doc.replace(parsed.layers, parsed.drafts)
  return drawingOf(doc, parsed, originals, originals.length > 0 ? [{ first: originals[0]!.id, k: 0, n: originals.length }] : [])
}

/** parseDxf and drawingFrom in one go, into a new document. */
export function readDxf(text: string): DxfDrawing {
  return drawingFrom(createDocument(), parseDxf(text))
}
