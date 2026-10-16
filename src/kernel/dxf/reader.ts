import { TRUE_COLOR, type Color } from '../color'
import { createDocument, type Document, type Draft } from '../document'
import type { Entity } from '../entity/types'
import { normAngle } from '../geom/tol'
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

/** Pair i's value as a number; the value's line (2i + 2) in the error. */
function numberAt(pairs: PairList, i: number): number {
  const v = pairs.value(i)
  const x = Number(v)
  // Number('') and Number('  ') are 0; only then is the value worth a second look.
  if (Number.isFinite(x) && (x !== 0 || v.trim() !== '')) return x
  throw new Unsupported(`invalid number "${v.trim()}"`, 2 * i + 2)
}

/** The groups every entity may have. */
interface Head {
  handle: string | null
  layer: string
  aci: number | undefined
  trueColor: number | undefined
  paper: boolean
  /** Extrusion direction (210/220/230), (0, 0, 1) when absent. */
  ex: number
  ey: number
  ez: number
}

/** ACI 1–255, ByLayer (undefined), ByBlock shown as 7 (white in model space), or a 420 true color. */
function colorOf(h: Head): Color | undefined {
  if (h.trueColor !== undefined) return TRUE_COLOR | (h.trueColor & 0xffffff)
  if (h.aci === undefined) return undefined
  const a = Math.abs(h.aci)
  if (a === 0) return 7
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

/** A draft before its layer and color are resolved. */
type Parsed = Draft extends infer D ? (D extends Draft ? Omit<D, 'layer' | 'color'> : never) : never

/**
 * The entity readers of one file. They share one head, reset for each entity: a load of a million entities makes
 * no garbage per entity beyond the draft itself.
 */
function parser(pairs: PairList) {
  const codes = pairs.codes
  const head: Head = { handle: null, layer: '0', aci: undefined, trueColor: undefined, paper: false, ex: 0, ey: 0, ez: 1 }

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
    return { type: 'arc', cx: s * cx, cy, r, a0: normAngle(b0), a1: normAngle(b1) }
  }

  const polylineOf = (xy: number[], bulges: number[], closed: boolean): Parsed => {
    if (xy.length < 2) throw new Unsupported('it has no vertices')
    if (ocsSign(head) === -1) {
      for (let k = 0; k < xy.length; k += 2) xy[k] = -xy[k]!
      for (let k = 0; k < bulges.length; k++) bulges[k] = -bulges[k]!
    }
    return { type: 'polyline', pts: new Float64Array(xy), bulges: bulges.some((v) => v !== 0) ? new Float64Array(bulges) : null, closed }
  }

  const lwpolyline = (a: number, b: number): Parsed => {
    const xy: number[] = []
    const bulges: number[] = []
    let flags = 0
    for (let i = a + 1; i < b; i++) {
      const c = codes[i]!
      if (c === 70) flags = num(i)
      else if (c === 10) {
        xy.push(num(i), 0)
        bulges.push(0)
      } else if (c === 20 && xy.length > 0) xy[xy.length - 1] = num(i)
      else if (c === 42 && bulges.length > 0) bulges[bulges.length - 1] = num(i)
      else common(c, i)
    }
    return polylineOf(xy, bulges, (flags & 1) !== 0)
  }

  /** POLYLINE: the 2D kind, with its vertices (spline frame points left out); 3D polylines and meshes stay as is. */
  const polyline = (a: number, own: number, end: number): Parsed => {
    let flags = 0
    for (let i = a + 1; i < own; i++) {
      const c = codes[i]!
      if (c === 70) flags = num(i)
      else common(c, i)
    }
    if (flags & 8) throw new Unsupported('3D polylines are not supported')
    if (flags & (16 | 64)) throw new Unsupported('meshes are not supported')
    const xy: number[] = []
    const bulges: number[] = []
    let i = own
    while (i < end && pairs.is(i, 0, 'VERTEX')) {
      let x = 0
      let y = 0
      let bulge = 0
      let vflags = 0
      for (i++; i < end && codes[i] !== 0; i++) {
        const c = codes[i]!
        if (c === 10) x = num(i)
        else if (c === 20) y = num(i)
        else if (c === 42) bulge = num(i)
        else if (c === 70) vflags = num(i)
      }
      if (!(vflags & 16)) {
        xy.push(x, y)
        bulges.push(bulge)
      }
    }
    return polylineOf(xy, bulges, (flags & 1) !== 0)
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

interface Layers {
  /** The layer index for a name the file uses, created with defaults when the table lacks it. */
  of(name: string): number
}

function layerTable(doc: Document, pairs: PairList, start: number, end: number, warnings: string[]): Layers {
  const byName = new Map<string, number>()
  const add = (name: string, color: Color, visible: boolean, locked: boolean): number => {
    const key = name.toLowerCase()
    const known = byName.get(key)
    if (known !== undefined) return known
    let clean = name.replace(INVALID_NAME, '_').trim() || '_'
    if (clean !== name) warnings.push(`Layer "${name}" renamed "${clean}": its name has characters layers cannot have.`)
    while (doc.layers.indexOf(clean) !== -1 && clean.toLowerCase() !== '0') clean += '_'
    let index: number
    if (clean === '0') {
      index = 0
      doc.layers.update(0, { color, visible, locked })
    } else index = doc.layers.add({ name: clean, color, visible, locked })
    byName.set(key, index)
    return index
  }
  const t = findTable(pairs, start, end, 'LAYER')
  if (t) {
    t.entries.forEach((a, k) => {
      if (!pairs.is(a, 0, 'LAYER')) return
      const l = layerEntry(pairs, a, entryEnd(t, k))
      if (l.name !== '') add(l.name, l.color, l.visible, l.locked)
    })
  }
  return { of: (name) => add(name, 7, true, false) }
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
 * The drawing in an ASCII DXF: HEADER (kept whole, read for a few variables), the LAYER table, and the model
 * space entities of the ENTITIES section. LINE, POINT, CIRCLE, ARC, LWPOLYLINE and 2D POLYLINE become entities;
 * everything else, and what these hold that the document cannot (paper space, a tilted extrusion, a bad number),
 * stays as Opaque, written back unchanged. Blocks and the other sections are kept in the source for the writer.
 * Throws DxfError for a malformed file.
 */
export function readDxf(text: string): DxfDrawing {
  const pairs = tokenize(text)
  const ranges = sections(pairs)
  const warnings: string[] = []
  const doc = createDocument()
  const find = (name: string) => ranges.find((s) => s.name === name)

  const hs = find('HEADER')
  const header = hs ? readHeader(pairs, hs.start, hs.end) : new Map<string, string>()
  const tables = find('TABLES')
  const layers = layerTable(doc, pairs, tables?.start ?? 0, tables?.end ?? 0, warnings)

  const ents = find('ENTITIES')
  const recs = ents ? records(pairs, ents.start, ents.end) : { n: 0, starts: new Int32Array(0), owns: new Int32Array(0), ends: new Int32Array(0) }
  const { head, read, scanHead } = parser(pairs)
  const drafts: Draft[] = new Array(recs.n)
  const kept = new Map<string, number>()
  const keep = (key: string): void => void kept.set(key, (kept.get(key) ?? 0) + 1)
  for (let k = 0; k < recs.n; k++) {
    const a = recs.starts[k]!
    const own = recs.owns[k]!
    const end = recs.ends[k]!
    const name = pairs.value(a).trim()
    let draft: Draft | null = null
    try {
      const parsed = read(name, a, own, end)
      if (!parsed) keep(name)
      else if (head.paper) keep('paper space')
      else {
        const d = parsed as unknown as { layer: number; color?: Color }
        d.layer = layers.of(head.layer)
        const color = colorOf(head)
        if (color !== undefined) d.color = color
        draft = parsed as Draft
      }
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error
      warnings.push(`line ${error.line ?? 2 * a + 1}: ${name} kept as is: ${error.message}.`)
    }
    if (!draft) {
      // Kept as is: its head read leniently, for the layer and color it shows under.
      try {
        scanHead(a, own)
      } catch {
        // A bad color or flag: what was read so far stands.
      }
      const color = colorOf(head)
      draft = { type: 'opaque', layer: layers.of(head.layer), name, raw: text.slice(pairs.offset(a), pairs.offset(end)) }
      if (color !== undefined) (draft as { color?: Color }).color = color
    }
    drafts[k] = draft
  }
  for (const [key, n] of kept) {
    warnings.push(key === 'paper space' ? `${n} ${n === 1 ? 'entity' : 'entities'} in paper space kept as is (not drawn).` : `${n} ${key} kept as is (not drawn).`)
  }

  const originals: Entity[] = []
  if (drafts.length > 0) {
    doc.transact('OPEN', (tx) => {
      for (const d of drafts) originals.push(tx.add(d))
    })
  }
  doc.clearHistory()
  const firstId = originals[0]?.id ?? 1
  const loaded = (id: number): LoadedSpan | null => {
    const k = id - firstId
    if (!(k >= 0 && k < originals.length)) return null
    return { entity: originals[k]!, start: pairs.offset(recs.starts[k]!), end: pairs.offset(recs.ends[k]!) }
  }

  let handseed = parseInt(header.get('$HANDSEED') ?? '0', 16) || 0
  const codes = pairs.codes
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] !== 5 && codes[i] !== 105) continue
    // In the HEADER, group 5 is the value of $HANDSEED itself.
    if (hs && i >= hs.start && i < hs.end) continue
    const h = parseInt(pairs.value(i).trim(), 16)
    if (h >= handseed) handseed = h + 1
  }

  const lf = text.indexOf('\n')
  return {
    doc,
    warnings,
    source: {
      text,
      newline: lf > 0 && text.charCodeAt(lf - 1) === 13 ? '\r\n' : '\n',
      header,
      handseed,
      sections: ranges.map((s) => ({ name: s.name, start: pairs.offset(s.start - 2), end: pairs.offset(s.end + 1) })),
      loaded,
      handleOf(id) {
        const span = loaded(id)
        if (!span) return null
        const own = tokenize(text.slice(span.start, span.end))
        for (let i = 1; i < own.length && own.code(i) !== 0; i++) if (own.code(i) === 5) return own.value(i).trim()
        return null
      },
    },
  }
}
