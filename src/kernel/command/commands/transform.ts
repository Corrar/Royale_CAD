import type { Draft } from '../../document'
import { typeOf } from '../../entity/registry'
import type { Entity, PrimSink } from '../../entity/types'
import { mirroring, rotation, scaling, translation, type Affine, type Vec2 } from '../../geom/vec'
import { formatNumber, getNumber, getPoint, getSelection, type Command, type CommandContext, type Input, type Request } from '../runtime'

const isPoint = (v: unknown): v is Vec2 => typeof v === 'object' && v !== null

/** Past this many entities the preview would cost more than it shows. */
const PREVIEW_MAX = 500

/** The selected entities that can be edited: present, transformable, not on a locked layer (reported). */
function* editable(ctx: CommandContext): Generator<Request, Entity[], Input> {
  const ids = yield* getSelection(ctx)
  ctx.selection.clear()
  const present = ids.map((id) => ctx.doc.get(id)).filter((e): e is Entity => e !== undefined && typeOf(e).transform !== undefined)
  const free = present.filter((e) => !ctx.doc.layers.get(e.layer)!.locked)
  const locked = present.length - free.length
  if (locked > 0) ctx.message(locked === 1 ? '1 was on a locked layer.' : `${locked} were on a locked layer.`)
  return free
}

/** Preview of the entities moved by the transform the cursor gives (none when it gives null). */
function ghost(es: Entity[], at: (c: Vec2) => Affine | null, extra?: (c: Vec2, out: PrimSink) => void) {
  const shown = es.slice(0, PREVIEW_MAX)
  return (c: Vec2, out: PrimSink): void => {
    extra?.(c, out)
    const m = at(c)
    if (!m) return
    for (const e of shown) {
      const t = typeOf(e).transform!(e, m)
      typeOf(t).primitives(t, 0, out)
    }
  }
}

function apply(ctx: CommandContext, label: string, es: Entity[], m: Affine, copy: boolean): void {
  ctx.doc.transact(label, (tx) => {
    for (const e of es) {
      const t = typeOf(e).transform!(e, m)
      if (!copy) tx.replace(t)
      else {
        const { id: _id, ...draft } = t
        tx.add(draft as Draft)
      }
    }
  })
}

const rubber = (from: Vec2) => (c: Vec2, out: PrimSink): void => out.segment(from.x, from.y, c.x, c.y)

/** MOVE's and COPY's base point; Enter stands for Displacement, as in AutoCAD. */
const basePoint = () => getPoint('Specify base point', { keywords: ['Displacement'], default: 'Displacement', allowEmpty: true })

/** The displacement itself, a point taken from the origin (MOVE's and COPY's Displacement); Enter repeats the last one. */
function* displacement(ctx: CommandContext): Generator<Request, Vec2, Input> {
  const last = (ctx.vars.get('DISPLACEMENT') as Vec2 | undefined) ?? { x: 0, y: 0 }
  const d = yield* getPoint('Specify displacement', { allowEmpty: true, default: `${formatNumber(last.x)}, ${formatNumber(last.y)}` })
  const v = isPoint(d) ? d : last
  ctx.vars.set('DISPLACEMENT', v)
  return v
}

/** MOVE by a base point and a second point; Enter at the second takes the first as the displacement. */
export const move: Command = function* (ctx) {
  const es = yield* editable(ctx)
  if (es.length === 0) return
  const base = yield* basePoint()
  if (base === null || base === 'Displacement') {
    const d = yield* displacement(ctx)
    return apply(ctx, 'MOVE', es, translation(d.x, d.y), false)
  }
  if (!isPoint(base)) return
  const to = yield* getPoint('Specify second point or <use first point as displacement>', {
    base,
    allowEmpty: true,
    preview: ghost(es, (c) => translation(c.x - base.x, c.y - base.y), rubber(base)),
  })
  const d = isPoint(to) ? { x: to.x - base.x, y: to.y - base.y } : base
  apply(ctx, 'MOVE', es, translation(d.x, d.y), false)
}

/**
 * COPY to as many second points as given, until Enter or Exit; Undo takes back the last copy. Enter before the
 * first copy copies once by the base point taken as the displacement, as MOVE does.
 */
export const copy: Command = function* (ctx) {
  const es = yield* editable(ctx)
  if (es.length === 0) return
  const base = yield* basePoint()
  if (base === null || base === 'Displacement') {
    const d = yield* displacement(ctx)
    return apply(ctx, 'COPY', es, translation(d.x, d.y), true)
  }
  if (!isPoint(base)) return
  let copies = 0
  for (;;) {
    const to = yield* getPoint(copies > 0 ? 'Specify second point' : 'Specify second point or <use first point as displacement>', {
      base,
      allowEmpty: true,
      keywords: copies > 0 ? ['Exit', 'Undo'] : [],
      preview: ghost(es, (c) => translation(c.x - base.x, c.y - base.y), rubber(base)),
    })
    if (to === null && copies === 0) return apply(ctx, 'COPY', es, translation(base.x, base.y), true)
    if (to === null || to === 'Exit') return
    if (to === 'Undo') {
      ctx.doc.undo()
      copies--
      continue
    }
    const p = to as Vec2
    apply(ctx, 'COPY', es, translation(p.x - base.x, p.y - base.y), true)
    copies++
  }
}

const angleTo = (base: Vec2, c: Vec2): number => (Math.atan2(c.y - base.y, c.x - base.x) * 180) / Math.PI

/**
 * ROTATE about a base point; the angle is typed in degrees or given by the direction of a picked point. The last
 * angle is the default, as in AutoCAD, so Enter turns the next set by as much.
 */
export const rotate: Command = function* (ctx) {
  const es = yield* editable(ctx)
  if (es.length === 0) return
  ctx.message('Current positive angle in UCS: ANGDIR=counterclockwise ANGBASE=0')
  const base = yield* getPoint('Specify base point')
  if (!isPoint(base)) return
  const a = yield* getNumber('Specify rotation angle', {
    base,
    angle: true,
    default: (ctx.vars.get('ROTATEANGLE') as number | undefined) ?? 0,
    preview: ghost(es, (c) => rotation(base, angleTo(base, c)), rubber(base)),
  })
  if (typeof a !== 'number') return
  ctx.vars.set('ROTATEANGLE', a)
  apply(ctx, 'ROTATE', es, rotation(base, a), false)
}

/** MIRROR across the line through two points, keeping the source unless told to erase it. */
export const mirror: Command = function* (ctx) {
  const es = yield* editable(ctx)
  if (es.length === 0) return
  const p1 = yield* getPoint('Specify first point of mirror line')
  if (!isPoint(p1)) return
  let p2: Vec2
  for (;;) {
    const q = yield* getPoint('Specify second point of mirror line', {
      base: p1,
      preview: ghost(es, (c) => (c.x === p1.x && c.y === p1.y ? null : mirroring(p1, c)), rubber(p1)),
    })
    if (!isPoint(q)) return
    if (q.x !== p1.x || q.y !== p1.y) {
      p2 = q
      break
    }
    ctx.message('The two points of the mirror line must differ.')
  }
  const erase = yield { kind: 'keyword', prompt: 'Erase source objects?', keywords: ['Yes', 'No'], default: 'No' }
  if (erase.kind !== 'keyword') return
  apply(ctx, 'MIRROR', es, mirroring(p1, p2), erase.word === 'No')
}

/**
 * SCALE about a base point; a picked point gives the factor as its distance from the base. The last factor (1 at
 * first) is the default, as in AutoCAD.
 */
export const scale: Command = function* (ctx) {
  const es = yield* editable(ctx)
  if (es.length === 0) return
  const base = yield* getPoint('Specify base point')
  if (!isPoint(base)) return
  const k = yield* getNumber('Specify scale factor', {
    base,
    default: (ctx.vars.get('SCALEFACTOR') as number | undefined) ?? 1,
    positive: true,
    preview: ghost(es, (c) => {
      const d = Math.hypot(c.x - base.x, c.y - base.y)
      return d > 0 ? scaling(base, d) : null
    }, rubber(base)),
  })
  if (typeof k !== 'number') return
  ctx.vars.set('SCALEFACTOR', k)
  apply(ctx, 'SCALE', es, scaling(base, k), false)
}
