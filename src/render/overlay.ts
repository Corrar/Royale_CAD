import { SNAP, type PrimSink } from '../kernel/entity/types'
import type { Vec2 } from '../kernel/geom/vec'
import { screenToWorld, worldToScreen, type ViewState } from '../kernel/view'

/** Arm length of the crosshair, CSS px. */
export const CROSSHAIR_PX = 40
/** Half size of a snap marker, CSS px. */
export const MARKER_PX = 6

export interface OverlayState {
  view: ViewState
  /** The cursor, CSS px from the viewport's top left; its last place after it left; null before it ever came. */
  cursor: Vec2 | null
  /** Draw the crosshair and pick box: false while the cursor is off the viewport (the rubber band stays). */
  crosshair?: boolean
  /** Show the pick box: a click would select. */
  pickbox: boolean
  /** Rubber band of the waiting request, in world coordinates. */
  preview: ((cursor: Vec2, out: PrimSink) => void) | null
  /** First corner of a selection window, world. */
  corner: Vec2 | null
  /** The object snap found under the cursor. */
  snap: { p: Vec2; mode: number } | null
  /** Where the preview goes, world: the snapped or ORTHO-squared cursor. Default: the snap point, else the cursor. */
  aim?: Vec2 | null
}

export interface OverlayTheme { crosshair: string; preview: string; window: string; windowFill: string; crossingFill: string; snap: string }

/**
 * Everything that follows the cursor, drawn with Canvas 2D over the GL view: selection window, rubber band,
 * crosshair and pick box. Cheap enough to redraw on every mouse move without touching the GPU scene.
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, s: OverlayState, theme: OverlayTheme, pickboxPx: number): void {
  const { view } = s
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0)
  ctx.clearRect(0, 0, view.width, view.height)
  if (!s.cursor) return
  // Odd widths are crisp on pixel centres.
  const px = (v: number): number => Math.floor(v) + 0.5
  ctx.lineWidth = 1

  if (s.corner) {
    const a = worldToScreen(view, s.corner.x, s.corner.y)
    const b = s.cursor
    // Left to right: window. Right to left: crossing, dashed, as in AutoCAD.
    const crossing = b.x < a.x
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const w = Math.abs(b.x - a.x)
    const h = Math.abs(b.y - a.y)
    ctx.fillStyle = crossing ? theme.crossingFill : theme.windowFill
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = theme.window
    ctx.setLineDash(crossing ? [6, 4] : [])
    ctx.strokeRect(px(x), px(y), Math.round(w), Math.round(h))
    ctx.setLineDash([])
  }

  if (s.preview) {
    const p = s.aim ?? s.snap?.p ?? screenToWorld(view, s.cursor.x, s.cursor.y)
    ctx.beginPath()
    s.preview(p, {
      segment(x0, y0, x1, y1) {
        const a = worldToScreen(view, x0, y0)
        const b = worldToScreen(view, x1, y1)
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
      },
      arc(cx, cy, r, a0, sweep) {
        const c = worldToScreen(view, cx, cy)
        // The screen's Y points down: a counter-clockwise sweep in the world is anticlockwise on the canvas.
        ctx.moveTo(c.x + r * view.scale * Math.cos(a0), c.y - r * view.scale * Math.sin(a0))
        ctx.arc(c.x, c.y, r * view.scale, -a0, -(a0 + sweep), sweep > 0)
      },
    })
    ctx.strokeStyle = theme.preview
    ctx.stroke()
  }

  if (s.snap) {
    const m = worldToScreen(view, s.snap.p.x, s.snap.p.y)
    ctx.lineWidth = 2
    ctx.strokeStyle = theme.snap
    ctx.beginPath()
    marker(ctx, s.snap.mode, m.x, m.y, MARKER_PX)
    ctx.stroke()
    ctx.lineWidth = 1
  }

  if (s.crosshair === false) return
  const x = px(s.cursor.x)
  const y = px(s.cursor.y)
  ctx.beginPath()
  ctx.moveTo(x - CROSSHAIR_PX, y)
  ctx.lineTo(x + CROSSHAIR_PX, y)
  ctx.moveTo(x, y - CROSSHAIR_PX)
  ctx.lineTo(x, y + CROSSHAIR_PX)
  ctx.strokeStyle = theme.crosshair
  ctx.stroke()
  if (s.pickbox) ctx.strokeRect(x - pickboxPx, y - pickboxPx, 2 * pickboxPx, 2 * pickboxPx)
}

/**
 * AutoCAD's marker shapes, traced into the current path: square END, triangle MID, circle CEN, cross INT,
 * diamond QUA, right angle PER, hourglass NEA, crossed circle NOD, two squares INS.
 */
function marker(ctx: CanvasRenderingContext2D, mode: number, x: number, y: number, k: number): void {
  const cross = (): void => {
    ctx.moveTo(x - k, y - k)
    ctx.lineTo(x + k, y + k)
    ctx.moveTo(x + k, y - k)
    ctx.lineTo(x - k, y + k)
  }
  switch (mode) {
    case SNAP.END:
      ctx.rect(x - k, y - k, 2 * k, 2 * k)
      return
    case SNAP.MID:
      ctx.moveTo(x, y - k)
      ctx.lineTo(x + k, y + k * 0.75)
      ctx.lineTo(x - k, y + k * 0.75)
      ctx.closePath()
      return
    case SNAP.INT:
      return cross()
    case SNAP.QUA:
      ctx.moveTo(x, y - k)
      ctx.lineTo(x + k, y)
      ctx.lineTo(x, y + k)
      ctx.lineTo(x - k, y)
      ctx.closePath()
      return
    case SNAP.PER:
      ctx.moveTo(x - k, y - k)
      ctx.lineTo(x - k, y + k)
      ctx.lineTo(x + k, y + k)
      ctx.moveTo(x - k, y)
      ctx.lineTo(x, y)
      ctx.lineTo(x, y + k)
      return
    case SNAP.NEA:
      ctx.moveTo(x - k, y - k)
      ctx.lineTo(x + k, y - k)
      ctx.lineTo(x - k, y + k)
      ctx.lineTo(x + k, y + k)
      ctx.closePath()
      return
    case SNAP.NOD:
      ctx.moveTo(x + k, y)
      ctx.arc(x, y, k, 0, 2 * Math.PI)
      return cross()
    case SNAP.INS:
      // Two squares, one over the other's corner.
      ctx.rect(x - k, y - k, k, k)
      ctx.rect(x - k / 2, y - k / 2, 1.5 * k, 1.5 * k)
      return
    default:
      ctx.arc(x, y, k, 0, 2 * Math.PI)
  }
}
