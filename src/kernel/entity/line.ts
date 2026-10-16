import { segmentDistance } from '../geom/vec'
import type { EntityType, Line } from './types'

export const lineType: EntityType<Line> = {
  type: 'line',
  bbox: (e) => ({ minX: Math.min(e.x0, e.x1), minY: Math.min(e.y0, e.y1), maxX: Math.max(e.x0, e.x1), maxY: Math.max(e.y0, e.y1) }),
  primitives: (e, _tol, out) => out.segment(e.x0, e.y0, e.x1, e.y1),
  distance: (e, p) => segmentDistance(p.x, p.y, e.x0, e.y0, e.x1, e.y1),
}
