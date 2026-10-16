import { describe, expect, it } from 'vitest'
import type { ViewState } from '../kernel/view'
import { CROSSHAIR_PX, drawOverlay, type OverlayState, type OverlayTheme } from './overlay'

const THEME: OverlayTheme = { crosshair: '#fff', preview: '#0ff', window: '#0ff', windowFill: 'rgba(0,255,255,0.1)', crossingFill: 'rgba(0,255,255,0.05)', snap: '#fb0' }
const VIEW: ViewState = { cx: 0, cy: 0, scale: 10, width: 200, height: 100, dpr: 2 }

type Call = [string, ...unknown[]]
function fakeContext() {
  const calls: Call[] = []
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return (...args: unknown[]) => calls.push([prop, ...args])
    },
    set(target, prop: string, value) {
      target[prop] = value
      calls.push([`=${prop}`, value])
      return true
    },
  })
  // The test project has no DOM lib: the fake stands in for a CanvasRenderingContext2D.
  return { ctx: ctx as never, calls, named: (n: string) => calls.filter((c) => c[0] === n) }
}

const state = (s: Partial<OverlayState>): OverlayState => ({ view: VIEW, cursor: null, pickbox: false, preview: null, corner: null, snap: null, ...s })

describe('drawOverlay', () => {
  it('clears in device px and draws nothing else without a cursor', () => {
    const f = fakeContext()
    drawOverlay(f.ctx, state({}), THEME, 5)
    expect(f.named('setTransform')).toEqual([['setTransform', 2, 0, 0, 2, 0, 0]])
    expect(f.named('clearRect')).toEqual([['clearRect', 0, 0, 200, 100]])
    expect(f.named('stroke')).toEqual([])
  })

  it('draws the crosshair on pixel centres, and the pick box when picking', () => {
    const f = fakeContext()
    drawOverlay(f.ctx, state({ cursor: { x: 50.3, y: 20.7 }, pickbox: true }), THEME, 5)
    expect(f.named('moveTo')).toContainEqual(['moveTo', 50.5 - CROSSHAIR_PX, 20.5])
    expect(f.named('lineTo')).toContainEqual(['lineTo', 50.5, 20.5 + CROSSHAIR_PX])
    expect(f.named('strokeRect')).toEqual([['strokeRect', 45.5, 15.5, 10, 10]])
  })

  it('draws the preview in screen coordinates, arcs with flipped angles', () => {
    const f = fakeContext()
    drawOverlay(
      f.ctx,
      state({
        cursor: { x: 150, y: 50 },
        preview: (c, out) => {
          out.segment(0, 0, c.x, c.y)
          out.arc(0, 0, 2, 0, Math.PI / 2)
        },
      }),
      THEME,
      5,
    )
    // The cursor (150, 50) is world (5, 0); the origin is the centre (100, 50).
    expect(f.named('moveTo')[0]).toEqual(['moveTo', 100, 50])
    expect(f.named('lineTo')[0]).toEqual(['lineTo', 150, 50])
    expect(f.named('arc')).toEqual([['arc', 100, 50, 20, -0, -Math.PI / 2, true]])
  })

  it('a window from the left is solid, from the right dashed', () => {
    for (const [cursorX, dash] of [[150, []], [50, [6, 4]]] as const) {
      const f = fakeContext()
      drawOverlay(f.ctx, state({ cursor: { x: cursorX, y: 80 }, corner: { x: 0, y: 0 } }), THEME, 5)
      const rect = f.named('strokeRect')[0]!
      expect(rect.slice(1)).toEqual([Math.min(100, cursorX) + 0.5, 50.5, Math.abs(cursorX - 100), 30])
      expect(f.named('setLineDash')).toContainEqual(['setLineDash', dash])
      expect(f.calls).toContainEqual(['=fillStyle', cursorX > 100 ? THEME.windowFill : THEME.crossingFill])
    }
  })

  it('marks the snap point with the shape of its mode, and previews to the snapped point', () => {
    for (const [mode, shape] of [[1, 'strokeRect'], [2, 'closePath'], [4, 'arc']] as const) {
      const f = fakeContext()
      // The snap point is world (1, 0), screen (110, 50); the cursor is a little off it.
      drawOverlay(f.ctx, state({ cursor: { x: 113, y: 52 }, snap: { p: { x: 1, y: 0 }, mode }, preview: (c, out) => out.segment(0, 0, c.x, c.y) }), THEME, 5)
      expect(f.calls).toContainEqual(['=strokeStyle', THEME.snap])
      expect(f.named(shape).length).toBeGreaterThan(0)
      expect(f.named('lineTo')[0]).toEqual(['lineTo', 110, 50])
    }
  })
})
