import type { PrimSink } from '../../entity/types'
import { TAU } from '../../geom/tol'
import type { Vec2 } from '../../geom/vec'
import { getNumber, getPoint, type Command } from '../runtime'

/** CIRCLE by centre and radius or diameter. The last radius is the default (CIRCLERAD). */
export const circle: Command = function* (ctx) {
  const c = yield* getPoint('Specify center point for circle')
  if (c === null || typeof c === 'string') return
  const last = ctx.vars.get('CIRCLERAD') as number | undefined
  // The cursor's distance is the radius (k = 1) or the diameter (k = 1/2).
  const along = (k: number) => (p: Vec2, out: PrimSink): void => out.arc(c.x, c.y, Math.hypot(p.x - c.x, p.y - c.y) * k, 0, TAU)
  let r = yield* getNumber('Specify radius of circle', { base: c, keywords: ['Diameter'], default: last, positive: true, preview: along(1) })
  if (r === 'Diameter') {
    const d = yield* getNumber('Specify diameter of circle', { base: c, default: last && 2 * last, positive: true, preview: along(0.5) })
    if (typeof d !== 'number') return
    r = d / 2
  }
  if (typeof r !== 'number') return
  const radius = r
  ctx.vars.set('CIRCLERAD', radius)
  ctx.doc.transact('CIRCLE', (tx) => void tx.add({ type: 'circle', layer: ctx.layer, cx: c.x, cy: c.y, r: radius }))
}
