import { pathOf } from '../../entity/path'
import { typeOf } from '../../entity/registry'
import type { Arc, Entity, Line } from '../../entity/types'
import { bulgeToArc } from '../../geom/curve'
import { intersect } from '../../geom/intersect'
import { TAU, normAngle } from '../../geom/tol'
import type { Vec2 } from '../../geom/vec'
import { getPoint, type Command, type CommandContext } from '../runtime'
import { edgeSet, edgesNear, picked } from './trim'

/** How far from q along the unit direction dir the nearest boundary lies (beyond tol); null when none does. */
function rayHit(ctx: CommandContext, q: Vec2, dir: Vec2, edges: Set<number> | null, self: number, tol: number): number | null {
  // Everything the ray can reach lies in the quadrant it heads into.
  const quadrant = {
    minX: dir.x < 0 ? -Infinity : q.x,
    maxX: dir.x > 0 ? Infinity : q.x,
    minY: dir.y < 0 ? -Infinity : q.y,
    maxY: dir.y > 0 ? Infinity : q.y,
  }
  let best = Infinity
  for (const b of edgesNear(ctx, quadrant, edges, self)) {
    const box = typeOf(b).bbox(b)
    // The ray stops past the farthest corner of the boundary's box.
    const reach = Math.max((box.minX - q.x) * dir.x, (box.maxX - q.x) * dir.x) + Math.max((box.minY - q.y) * dir.y, (box.maxY - q.y) * dir.y)
    if (!(reach > tol)) continue
    const L = reach * 1.001 + tol
    const ray: Line = { type: 'line', id: 0, layer: 0, x0: q.x, y0: q.y, x1: q.x + dir.x * L, y1: q.y + dir.y * L }
    for (const p of intersect(ray, b)) {
      const d = (p.x - q.x) * dir.x + (p.y - q.y) * dir.y
      if (d > tol && d < best) best = d
    }
  }
  return best < Infinity ? best : null
}

/**
 * How far round the circle (c, r) from angle `from`, turning counter-clockwise (turn 1) or clockwise (−1), the
 * nearest boundary lies; less than `gap`, the turn that would close the circle. Null when none does.
 */
function circleHit(ctx: CommandContext, c: Vec2, r: number, from: number, turn: 1 | -1, gap: number, edges: Set<number> | null, self: number, slack: number): number | null {
  const lo = turn > 0 ? from : from - gap
  const span: Arc = { type: 'arc', id: 0, layer: 0, cx: c.x, cy: c.y, r, a0: normAngle(lo), a1: normAngle(lo + gap) }
  let best = Infinity
  for (const b of edgesNear(ctx, typeOf(span).bbox(span), edges, self)) {
    for (const p of intersect(span, b)) {
      const a = Math.atan2(p.y - c.y, p.x - c.x)
      const d = turn > 0 ? normAngle(a - from) : normAngle(from - a)
      if (d > slack && d < gap - slack && d < best) best = d
    }
  }
  return best < Infinity ? best : null
}

const MISSED = 'Object does not intersect an edge.'

/** e with the end nearer to `at` taken to the nearest boundary, or the reason it cannot be. */
function extended(ctx: CommandContext, e: Entity, at: Vec2, edges: Set<number> | null): Entity | string {
  const path = pathOf(e)
  if (!path) return 'Cannot extend this object.'
  if (path.closed) return 'Cannot extend a closed object.'
  // Nearer by length along the object: a polyline's parameter counts vertices, whatever their pieces' lengths.
  const atEnd = path.along(path.param(at)) >= path.along(path.end) / 2
  switch (e.type) {
    case 'line': {
      const len = Math.hypot(e.x1 - e.x0, e.y1 - e.y0)
      if (len === 0) return 'Cannot extend this object.'
      const q = atEnd ? { x: e.x1, y: e.y1 } : { x: e.x0, y: e.y0 }
      const s = atEnd ? 1 : -1
      const dir = { x: (s * (e.x1 - e.x0)) / len, y: (s * (e.y1 - e.y0)) / len }
      const d = rayHit(ctx, q, dir, edges, e.id, path.slack(0) * len)
      if (d === null) return MISSED
      const p = { x: q.x + dir.x * d, y: q.y + dir.y * d }
      return atEnd ? { ...e, x1: p.x, y1: p.y } : { ...e, x0: p.x, y0: p.y }
    }
    case 'arc': {
      const d = circleHit(ctx, { x: e.cx, y: e.cy }, e.r, atEnd ? e.a1 : e.a0, atEnd ? 1 : -1, TAU - path.end, edges, e.id, path.slack(0))
      if (d === null) return MISSED
      return atEnd ? { ...e, a1: normAngle(e.a1 + d) } : { ...e, a0: normAngle(e.a0 - d) }
    }
    case 'circle':
      return 'Cannot extend a closed object.'
    case 'point':
    case 'opaque':
    case 'ellipse':
    case 'spline':
    case 'insert':
    case 'text':
    case 'mtext':
    case 'solid':
      return 'Cannot extend this object.'
    case 'polyline': {
      // The end piece, straight along its direction or round its circle; the inner vertices stay. It is the last
      // (or first) piece with a length, slack 1 meaning the whole piece is within the tolerance; repeats of its end
      // vertex past it move with that vertex.
      const n = e.pts.length >> 1
      let i = atEnd ? n - 2 : 0
      while (i >= 0 && i < n - 1 && path.slack(i) >= 1) i += atEnd ? -1 : 1
      if (i < 0 || i >= n - 1) return 'Cannot extend this object.'
      const fixed = atEnd ? i : i + 1
      const moving = atEnd ? i + 1 : i
      const v = (k: number): Vec2 => ({ x: e.pts[2 * k]!, y: e.pts[2 * k + 1]! })
      const bulge = e.bulges?.[i] ?? 0
      const a = bulge !== 0 ? bulgeToArc(v(i), v(i + 1), bulge) : null
      const pts = e.pts.slice()
      const bulges = e.bulges?.slice() ?? null
      const moveEnd = (x: number, y: number): void => {
        for (let k = moving; k >= 0 && k < n; k += atEnd ? 1 : -1) {
          pts[2 * k] = x
          pts[2 * k + 1] = y
        }
      }
      if (a) {
        const sign = a.sweep >= 0 ? 1 : -1
        const turn = atEnd ? sign : (-sign as 1 | -1)
        const from = atEnd ? a.a0 + a.sweep : a.a0
        // The path's slack is a fraction of the piece; circleHit wants an angle.
        const d = circleHit(ctx, { x: a.cx, y: a.cy }, a.r, from, turn, TAU - Math.abs(a.sweep), edges, e.id, path.slack(i) * Math.abs(a.sweep))
        if (d === null) return MISSED
        const end = from + turn * d
        moveEnd(a.cx + a.r * Math.cos(end), a.cy + a.r * Math.sin(end))
        bulges![i] = Math.tan((a.sweep + sign * d) / 4)
      } else {
        const p = v(moving)
        const o = v(fixed)
        const len = Math.hypot(p.x - o.x, p.y - o.y)
        const dir = { x: (p.x - o.x) / len, y: (p.y - o.y) / len }
        const d = rayHit(ctx, p, dir, edges, e.id, path.slack(i) * len)
        if (d === null) return MISSED
        moveEnd(p.x + dir.x * d, p.y + dir.y * d)
      }
      return { ...e, pts, bulges }
    }
  }
}

/** EXTEND: each pick takes the nearer end of an object to the nearest boundary, until Enter. */
export const extend: Command = function* (ctx) {
  const edges = yield* edgeSet(ctx, 'boundary edges')
  let extensions = 0
  for (;;) {
    const r = yield* getPoint('Select object to extend', { pick: true, allowEmpty: true, keywords: ['Undo'] })
    if (r === null) return
    if (r === 'Undo') {
      if (extensions > 0) {
        ctx.doc.undo()
        extensions--
      } else ctx.message('Nothing to undo.')
      continue
    }
    if (typeof r === 'string') continue
    const e = picked(ctx, r)
    if (!e) continue
    const out = extended(ctx, e, r, edges)
    if (typeof out === 'string') {
      ctx.message(out)
      continue
    }
    ctx.doc.transact('EXTEND', (tx) => tx.replace(out))
    extensions++
  }
}
