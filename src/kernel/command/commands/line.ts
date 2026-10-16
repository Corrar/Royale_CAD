import type { Vec2 } from '../../geom/vec'
import { getPoint, type Command } from '../runtime'

/** LINE: one entity per segment, each its own transaction, so Undo inside the command takes back the last one. */
export const line: Command = function* (ctx) {
  const first = yield* getPoint('Specify first point')
  if (first === null || typeof first === 'string') return
  const pts: Vec2[] = [first]
  for (;;) {
    const from = pts[pts.length - 1]!
    const segments = pts.length - 1
    const r = yield* getPoint('Specify next point', {
      base: from,
      allowEmpty: true,
      keywords: segments >= 2 ? ['Close', 'Undo'] : ['Undo'],
      preview: (c, out) => out.segment(from.x, from.y, c.x, c.y),
    })
    if (r === null) return
    if (r === 'Undo') {
      if (segments === 0) ctx.message('All segments already undone.')
      else {
        ctx.doc.undo()
        pts.pop()
      }
      continue
    }
    const to = r === 'Close' ? pts[0]! : (r as Vec2)
    ctx.doc.transact('LINE', (tx) => void tx.add({ type: 'line', layer: ctx.layer, x0: from.x, y0: from.y, x1: to.x, y1: to.y }))
    if (r === 'Close') return
    pts.push(to)
  }
}
