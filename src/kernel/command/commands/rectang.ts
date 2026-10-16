import type { Vec2 } from '../../geom/vec'
import { getPoint, type Command } from '../runtime'

const isPoint = (v: unknown): v is Vec2 => typeof v === 'object' && v !== null

const corners = (a: Vec2, b: Vec2): number[] => [a.x, a.y, b.x, a.y, b.x, b.y, a.x, b.y]

/** RECTANG: a closed polyline of four vertices from two opposite corners, starting at the first. */
export const rectang: Command = function* (ctx) {
  const a = yield* getPoint('Specify first corner point')
  if (!isPoint(a)) return
  for (;;) {
    const b = yield* getPoint('Specify other corner point', {
      preview: (c, out) => {
        const v = corners(a, c)
        for (let i = 0; i < 8; i += 2) out.segment(v[i]!, v[i + 1]!, v[(i + 2) % 8]!, v[(i + 3) % 8]!)
      },
    })
    if (!isPoint(b)) return
    if (b.x === a.x || b.y === a.y) {
      ctx.message('The rectangle has no area.')
      continue
    }
    ctx.doc.transact('RECTANG', (tx) => void tx.add({ type: 'polyline', layer: ctx.layer, pts: Float64Array.from(corners(a, b)), bulges: null, closed: true }))
    return
  }
}
