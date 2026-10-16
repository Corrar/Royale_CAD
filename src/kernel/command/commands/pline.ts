import type { PrimSink } from '../../entity/types'
import { bulgeToArc } from '../../geom/curve'
import type { Vec2 } from '../../geom/vec'
import { getPoint, type Command } from '../runtime'

const isPoint = (v: unknown): v is Vec2 => typeof v === 'object' && v !== null

/** Bulge of the arc from p to q that leaves p along dir: tan of half the angle from dir to the chord. */
function tangentBulge(dir: Vec2, p: Vec2, q: Vec2): number {
  const cx = q.x - p.x
  const cy = q.y - p.y
  const alpha = Math.atan2(dir.x * cy - dir.y * cx, dir.x * cx + dir.y * cy)
  return Math.tan(alpha / 2)
}

/** Direction at the end of the piece from p to q with the given bulge. */
function endDirection(p: Vec2, q: Vec2, bulge: number): Vec2 {
  const a = Math.atan2(q.y - p.y, q.x - p.x) + 2 * Math.atan(bulge) // chord turned by half the included angle
  return { x: Math.cos(a), y: Math.sin(a) }
}

function piece(p: Vec2, q: Vec2, bulge: number, out: PrimSink): void {
  const a = bulge !== 0 ? bulgeToArc(p, q, bulge) : null
  if (a) out.arc(a.cx, a.cy, a.r, a.a0, a.sweep)
  else out.segment(p.x, p.y, q.x, q.y)
}

/**
 * PLINE: lines and arcs tangent to the previous piece, as one polyline. It grows as a preview and becomes one
 * entity when the command ends, Esc included, as in AutoCAD.
 */
export const pline: Command = function* (ctx) {
  const start = yield* getPoint('Specify start point')
  if (!isPoint(start)) return
  ctx.message('Current line-width is 0.0000')
  const pts: Vec2[] = [start]
  const bulges: number[] = [] // bulges[i] shapes the piece from pts[i] to pts[i + 1]
  let closed = false
  let arcs = false
  const direction = (): Vec2 => {
    const n = pts.length
    return n < 2 ? { x: 1, y: 0 } : endDirection(pts[n - 2]!, pts[n - 1]!, bulges[n - 2]!)
  }
  try {
    for (;;) {
      const last = pts[pts.length - 1]!
      const closeable = pts.length >= 3 ? ['Close'] : []
      const nextBulge = (q: Vec2): number => (arcs ? tangentBulge(direction(), last, q) : 0)
      const r: Vec2 | string | null = yield* getPoint(arcs ? 'Specify endpoint of arc' : 'Specify next point', {
        base: last,
        allowEmpty: true,
        keywords: arcs ? [...closeable, 'Line', 'Undo'] : ['Arc', ...closeable, 'Undo'],
        preview: (c, out) => {
          for (let i = 0; i + 1 < pts.length; i++) piece(pts[i]!, pts[i + 1]!, bulges[i]!, out)
          piece(last, c, nextBulge(c), out)
        },
      })
      if (r === null) return
      if (r === 'Arc' || r === 'Line') {
        arcs = r === 'Arc'
        continue
      }
      if (r === 'Undo') {
        if (pts.length === 1) ctx.message('All segments already undone.')
        else {
          pts.pop()
          bulges.pop()
          ctx.setLastPoint(pts[pts.length - 1]!)
        }
        continue
      }
      const q = r === 'Close' ? start : (r as Vec2)
      const b = nextBulge(q)
      if (!Number.isFinite(b) || Math.abs(b) > 1e6) {
        ctx.message('The arc would turn back on itself.')
        continue
      }
      bulges.push(b)
      if (r === 'Close') {
        closed = true
        return ctx.setLastPoint(start)
      }
      pts.push(q)
    }
  } finally {
    if (pts.length >= 2) {
      const flat = Float64Array.from(pts.flatMap((p) => [p.x, p.y]))
      const all = closed ? bulges : [...bulges, 0]
      ctx.doc.transact('PLINE', (tx) => {
        tx.add({ type: 'polyline', layer: ctx.layer, pts: flat, bulges: all.some((b) => b !== 0) ? Float64Array.from(all) : null, closed })
      })
    }
  }
}
