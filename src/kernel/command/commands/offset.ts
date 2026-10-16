import type { Draft } from '../../document'
import { typeOf } from '../../entity/registry'
import type { Entity } from '../../entity/types'
import type { Vec2 } from '../../geom/vec'
import { getPoint, type Command, type CommandContext, type Input, type Request } from '../runtime'

const isPoint = (v: unknown): v is Vec2 => typeof v === 'object' && v !== null

/** OFFSETDIST: a distance, or Through (the copy passes through a point). */
type Dist = number | 'Through'

const NO_POLYLINES = 'Polylines cannot be offset yet.'

/**
 * The copy of e at distance d (or through the point, for Through) on the side of p; same id, layer and color.
 * A string says why there is none.
 */
export function offsetOf(e: Entity, dist: Dist, p: Vec2): Entity | string {
  switch (e.type) {
    case 'line': {
      const dx = e.x1 - e.x0
      const dy = e.y1 - e.y0
      const len = Math.hypot(dx, dy)
      if (len === 0) return 'Cannot offset a line of zero length.'
      // Signed distance of p from the line, positive to the left of its direction.
      const s = ((p.y - e.y0) * dx - (p.x - e.x0) * dy) / len
      if (s === 0) return 'The point is on the object.'
      const d = dist === 'Through' ? s : Math.sign(s) * dist
      const ox = (-dy / len) * d
      const oy = (dx / len) * d
      return { ...e, x0: e.x0 + ox, y0: e.y0 + oy, x1: e.x1 + ox, y1: e.y1 + oy }
    }
    case 'circle':
    case 'arc': {
      const from = Math.hypot(p.x - e.cx, p.y - e.cy)
      const r = dist === 'Through' ? from : from > e.r ? e.r + dist : e.r - dist
      if (!(r > 0)) return 'Cannot offset: the radius would be zero or less.'
      if (r === e.r) return 'The point is on the object.'
      return { ...e, r }
    }
    case 'polyline':
      // shortcut: offsetting a polyline joins the offset pieces at each vertex (extending or rounding them) and
      // drops pieces that vanish; it waits for that join logic.
      return NO_POLYLINES
    case 'point':
    case 'opaque':
      return 'Cannot offset that object.'
  }
}

/** The offset distance: a number, two points, or Through; Enter keeps the last one. */
function* distance(ctx: CommandContext): Generator<Request, Dist | null, Input> {
  const last = (ctx.vars.get('OFFSETDIST') as Dist | undefined) ?? 'Through'
  for (;;) {
    const input = yield { kind: 'point', prompt: 'Specify offset distance', keywords: ['Through'], default: String(last), acceptNumber: true, allowEmpty: true }
    if (input.kind === 'empty') return last
    if (input.kind === 'keyword') return 'Through'
    if (input.kind === 'number') {
      if (input.value > 0) return input.value
      ctx.message('Value must be positive and nonzero.')
      continue
    }
    if (input.kind !== 'point') return null
    const a = input.p
    const b = yield* getPoint('Specify second point', { base: a, preview: (c, out) => out.segment(a.x, a.y, c.x, c.y) })
    if (!isPoint(b)) return null
    const d = Math.hypot(b.x - a.x, b.y - a.y)
    if (d > 0) return d
    ctx.message('Value must be positive and nonzero.')
  }
}

/** OFFSET: a parallel copy of a line, circle or arc, at a distance or through a point, until Exit. */
export const offset: Command = function* (ctx) {
  ctx.message('Current settings: Erase source=No Layer=Source')
  const dist = yield* distance(ctx)
  if (dist === null) return
  ctx.vars.set('OFFSETDIST', dist)
  let made = 0
  const undoLast = (): void => {
    if (made > 0) {
      ctx.doc.undo()
      made--
    } else ctx.message('Nothing to undo.')
  }
  for (;;) {
    const s = yield* getPoint('Select object to offset', { pick: true, allowEmpty: true, keywords: ['Exit', 'Undo'], default: 'Exit' })
    if (s === null || s === 'Exit') return
    if (s === 'Undo') {
      undoLast()
      continue
    }
    if (!isPoint(s)) continue
    const id = ctx.host.pick?.(s) ?? null
    const e = id === null ? undefined : ctx.doc.get(id)
    if (!e) continue
    if (e.type === 'polyline') {
      ctx.message(NO_POLYLINES)
      continue
    }
    // The source stays highlighted while the side is asked for.
    ctx.selection.clear()
    ctx.selection.add([e.id])
    const p = yield* getPoint(dist === 'Through' ? 'Specify through point' : 'Specify point on side to offset', {
      allowEmpty: true,
      keywords: ['Exit', 'Undo'],
      default: 'Exit',
      preview: (c, out) => {
        const o = offsetOf(e, dist, c)
        if (typeof o !== 'string') typeOf(o).primitives(o, 0, out)
      },
    })
    ctx.selection.clear()
    if (p === null || p === 'Exit') return
    if (p === 'Undo') {
      undoLast()
      continue
    }
    if (!isPoint(p)) continue
    const o = offsetOf(e, dist, p)
    if (typeof o === 'string') {
      ctx.message(o)
      continue
    }
    const { id: _id, ...draft } = o
    ctx.doc.transact('OFFSET', (tx) => void tx.add(draft as Draft))
    made++
  }
}
