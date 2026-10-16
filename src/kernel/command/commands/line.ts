import type { Vec2 } from '../../geom/vec'
import { getNumber, getPoint, type Command } from '../runtime'

/**
 * Where the last line or arc drawn ended: Enter at LINE's first point continues from there, as in AutoCAD. After an
 * arc, also the direction it was drawn in at its end: the line goes on tangent to it.
 */
export interface LastEnd {
  p: Vec2
  tangent?: Vec2
}

export const LAST_END = 'LINE_END'

/** LINE: one entity per segment, each its own transaction, so Undo inside the command takes back the last one. */
export const line: Command = function* (ctx) {
  let first = yield* getPoint('Specify first point', { allowEmpty: true })
  let tangent: Vec2 | undefined
  if (first === null) {
    const last = ctx.vars.get(LAST_END) as LastEnd | undefined
    if (!last) return ctx.message('No line or arc to continue.')
    first = last.p
    tangent = last.tangent
    ctx.setLastPoint(first)
  }
  if (typeof first === 'string') return
  const pts: Vec2[] = [first]
  const draw = (from: Vec2, to: Vec2): void => {
    ctx.doc.transact('LINE', (tx) => void tx.add({ type: 'line', layer: ctx.layer, x0: from.x, y0: from.y, x1: to.x, y1: to.y }))
    ctx.vars.set(LAST_END, { p: to } satisfies LastEnd)
  }
  if (tangent) {
    // After an arc the direction is the arc's: AutoCAD asks only for the length.
    const start = first
    const t = tangent
    const along = (k: number): Vec2 => ({ x: start.x + t.x * k, y: start.y + t.y * k })
    const len = yield* getNumber('Length of line', {
      base: start,
      positive: true,
      preview: (c, out) => {
        const q = along(Math.hypot(c.x - start.x, c.y - start.y))
        out.segment(start.x, start.y, q.x, q.y)
      },
    })
    if (typeof len !== 'number') return
    const to = along(len)
    draw(start, to)
    ctx.setLastPoint(to)
    pts.push(to)
  }
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
        // @ goes from where the rubber band starts again.
        ctx.setLastPoint(pts[pts.length - 1]!)
      }
      continue
    }
    const to = r === 'Close' ? pts[0]! : (r as Vec2)
    draw(from, to)
    if (r === 'Close') return ctx.setLastPoint(to)
    pts.push(to)
  }
}
