import type { Arc } from '../../entity/types'
import { arcThrough, type ArcGeom } from '../../geom/curve'
import { TAU, normAngle } from '../../geom/tol'
import type { Vec2 } from '../../geom/vec'
import { getPoint, type Command, type CommandContext } from '../runtime'
import { LAST_END, type LastEnd } from './line'

const isPoint = (v: unknown): v is Vec2 => typeof v === 'object' && v !== null

/** The entity for an arc with a signed sweep: Arc runs counter-clockwise from a0 to a1. */
export function arcEntity(ctx: CommandContext, g: ArcGeom): Omit<Arc, 'id'> {
  const start = g.sweep >= 0 ? g.a0 : g.a0 + g.sweep
  return { type: 'arc', layer: ctx.layer, cx: g.cx, cy: g.cy, r: g.r, a0: normAngle(start), a1: normAngle(start + Math.abs(g.sweep)) }
}

/** Adds the arc and keeps where it ends, heading the way it was drawn, for LINE's Enter (LINE_END). */
function draw(ctx: CommandContext, g: ArcGeom): void {
  ctx.doc.transact('ARC', (tx) => void tx.add(arcEntity(ctx, g)))
  const end = g.a0 + g.sweep
  const turn = Math.sign(g.sweep) // a clockwise arc heads the other way round
  const last: LastEnd = {
    p: { x: g.cx + g.r * Math.cos(end), y: g.cy + g.r * Math.sin(end) },
    tangent: { x: -turn * Math.sin(end), y: turn * Math.cos(end) },
  }
  ctx.vars.set(LAST_END, last)
}

/** ARC through three points (AutoCAD's default), or by Center, start and end, counter-clockwise. */
export const arc: Command = function* (ctx) {
  const first = yield* getPoint('Specify start point of arc', { keywords: ['Center'] })
  if (first === 'Center') {
    const c = yield* getPoint('Specify center point of arc')
    if (!isPoint(c)) return
    const s = yield* getPoint('Specify start point of arc', { base: c, preview: (p, out) => out.segment(c.x, c.y, p.x, p.y) })
    if (!isPoint(s)) return
    const r = Math.hypot(s.x - c.x, s.y - c.y)
    if (r === 0) return ctx.message('The start point is the center.')
    const a0 = Math.atan2(s.y - c.y, s.x - c.x)
    const sweepTo = (p: Vec2): number => normAngle(Math.atan2(p.y - c.y, p.x - c.x) - a0) || TAU
    const e = yield* getPoint('Specify end point of arc', { base: c, preview: (p, out) => out.arc(c.x, c.y, r, a0, sweepTo(p)) })
    if (!isPoint(e)) return
    draw(ctx, { cx: c.x, cy: c.y, r, a0, sweep: sweepTo(e) })
    return
  }
  if (!isPoint(first)) return
  const p1 = first
  const p2 = yield* getPoint('Specify second point of arc', { base: p1, preview: (p, out) => out.segment(p1.x, p1.y, p.x, p.y) })
  if (!isPoint(p2)) return
  for (;;) {
    const p3 = yield* getPoint('Specify end point of arc', {
      preview: (p, out) => {
        const g = arcThrough(p1, p2, p)
        if (g) out.arc(g.cx, g.cy, g.r, g.a0, g.sweep)
      },
    })
    if (!isPoint(p3)) return
    const g = arcThrough(p1, p2, p3)
    if (!g) {
      ctx.message('The points are collinear.')
      continue
    }
    draw(ctx, g)
    return
  }
}
