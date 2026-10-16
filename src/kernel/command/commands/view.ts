import type { Vec2 } from '../../geom/vec'
import { FIT_MARGIN_PX, fit, zoomAt } from '../../view'
import { getPoint, type Command, type CommandContext, type CommandGen } from '../runtime'

const isPoint = (v: unknown): v is Vec2 => typeof v === 'object' && v !== null

function* corners(ctx: CommandContext, first: Vec2 | null): CommandGen {
  const a = first ?? (yield* getPoint('Specify first corner'))
  if (!isPoint(a)) return
  const b = yield* getPoint('Specify opposite corner', {
    preview: (c, out) => {
      out.segment(a.x, a.y, c.x, a.y)
      out.segment(c.x, a.y, c.x, c.y)
      out.segment(c.x, c.y, a.x, c.y)
      out.segment(a.x, c.y, a.x, a.y)
    },
  })
  if (!isPoint(b)) return
  const v = ctx.host.getView!()
  ctx.host.setView!(fit(v, { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) }, 0))
}

/**
 * ZOOM: a window by two corners, a scale factor (n or nX, relative to the current view), All or Extents (both
 * frame the drawing: there are no limits).
 */
export const zoom: Command = Object.assign(
  function* (ctx: CommandContext): CommandGen {
    if (!ctx.host.getView || !ctx.host.setView) return ctx.message('No view to zoom.')
    const input = yield {
      kind: 'point' as const,
      prompt: 'Specify corner of window, enter a scale factor (nX),',
      keywords: ['All', 'Extents', 'Window'],
      acceptNumber: true,
      allowEmpty: true,
    }
    const v = ctx.host.getView()
    if (input.kind === 'number') {
      if (!(input.value > 0)) return ctx.message('Requires a positive number.')
      return ctx.host.setView(zoomAt(v, v.width / 2, v.height / 2, input.value))
    }
    if (input.kind === 'keyword' && input.word !== 'Window') {
      const b = ctx.host.extents?.()
      if (!b) return ctx.message('The drawing is empty.')
      return ctx.host.setView(fit(v, b, FIT_MARGIN_PX))
    }
    if (input.kind === 'point' || (input.kind === 'keyword' && input.word === 'Window')) {
      yield* corners(ctx, input.kind === 'point' ? input.p : null)
    }
  },
  { noUndoGroup: true },
)

/** PAN from the command line: moves the drawing by a displacement, given as two points or one vector. */
export const pan: Command = Object.assign(
  function* (ctx: CommandContext): CommandGen {
    if (!ctx.host.getView || !ctx.host.setView) return ctx.message('No view to pan.')
    const a = yield* getPoint('Specify base point or displacement')
    if (!isPoint(a)) return
    const b = yield* getPoint('Specify second point', { base: a, allowEmpty: true, preview: (c, out) => out.segment(a.x, a.y, c.x, c.y) })
    // Enter at the second point: the first one is the displacement itself.
    const d = isPoint(b) ? { x: b.x - a.x, y: b.y - a.y } : a
    const v = ctx.host.getView()
    ctx.host.setView({ ...v, cx: v.cx - d.x, cy: v.cy - d.y })
  },
  { noUndoGroup: true },
)
