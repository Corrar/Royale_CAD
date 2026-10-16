import { describe, expect, it } from 'vitest'
import { typeOf } from '../kernel/entity/registry'
import type { Solid } from '../kernel/entity/types'
import type { ViewState } from '../kernel/view'
import { CAP_PER_EM } from '../kernel/text/font'
import { CROSSHAIR_PX, drawOverlay, TEXT_CAP_PX, type OverlayState, type OverlayTheme } from './overlay'

const THEME: OverlayTheme = {
  crosshair: '#fff', preview: '#0ff', window: '#0ff', windowFill: 'rgba(0,255,255,0.1)', crossingFill: 'rgba(0,255,255,0.05)', snap: '#fb0', textFamily: 'Inter',
}
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

  it('a moved solid is ghosted by its outline, without the diagonal that splits it', () => {
    const f = fakeContext()
    const square: Solid = { type: 'solid', id: 1, layer: 0, x0: 0, y0: 0, x1: 2, y1: 0, x2: 0, y2: 2, x3: 2, y3: 2 }
    drawOverlay(f.ctx, state({ cursor: { x: 150, y: 50 }, preview: (_c, out) => typeOf(square).primitives(square, 0, out) }), THEME, 5)
    // World (0, 0) is (100, 50) on screen, 10 px a unit, y up: the outline 1-2-4-3.
    expect(f.named('moveTo').slice(0, 4)).toEqual([['moveTo', 100, 50], ['moveTo', 120, 50], ['moveTo', 120, 30], ['moveTo', 100, 30]])
    expect(f.named('lineTo').slice(0, 4)).toEqual([['lineTo', 120, 50], ['lineTo', 120, 30], ['lineTo', 100, 30], ['lineTo', 100, 50]])
    // Then the crosshair's.
    expect(f.named('moveTo')[4]).toEqual(['moveTo', 150.5 - CROSSHAIR_PX, 50.5])
  })

  it('draws the glyphs of a preview in the text font, turned and scaled into place', () => {
    const f = fakeContext()
    // An H whose baseline starts at world (1, 2), one capital height (3) up the screen's x, turned 90°.
    drawOverlay(f.ctx, state({ cursor: { x: 0, y: 0 }, preview: (_c, out) => out.glyph?.(72, 1, 2, 0, 3, -3, 0) }), THEME, 5)
    expect(f.calls).toContainEqual(['=font', `${TEXT_CAP_PX / CAP_PER_EM}px ${THEME.textFamily}`])
    expect(f.calls).toContainEqual(['=fillStyle', THEME.preview])
    // (1, 2) is (110, 30) on screen, (220, 60) in device px; one capital height is 30 px, 60 device px.
    const k = 60 / TEXT_CAP_PX
    const at = f.calls.findIndex((c) => c[0] === 'fillText')
    expect(f.calls[at]).toEqual(['fillText', 'H', 0, 0])
    expect(f.calls.slice(0, at).filter((c) => c[0] === 'setTransform').at(-1)).toEqual(['setTransform', 0, -k, k, 0, 220, 60])
    // The view's own transform comes back after it.
    expect(f.calls.slice(at).map((c) => c[0])).toContain('restore')
  })

  it('with the cursor off the viewport: the rubber band stays, the crosshair goes', () => {
    const f = fakeContext()
    drawOverlay(f.ctx, state({ cursor: { x: 50, y: 20 }, crosshair: false, preview: (c, out) => out.segment(0, 0, c.x, c.y) }), THEME, 5)
    expect(f.calls).toContainEqual(['=strokeStyle', THEME.preview])
    expect(f.calls).not.toContainEqual(['=strokeStyle', THEME.crosshair])
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
    for (const [mode, shape] of [[1, 'rect'], [2, 'closePath'], [4, 'arc']] as const) {
      const f = fakeContext()
      // The snap point is world (1, 0), screen (110, 50); the cursor is a little off it.
      drawOverlay(f.ctx, state({ cursor: { x: 113, y: 52 }, snap: { p: { x: 1, y: 0 }, mode }, preview: (c, out) => out.segment(0, 0, c.x, c.y) }), THEME, 5)
      expect(f.calls).toContainEqual(['=strokeStyle', THEME.snap])
      expect(f.named(shape).length).toBeGreaterThan(0)
      expect(f.named('lineTo')[0]).toEqual(['lineTo', 110, 50])
    }
  })

  it('every snap mode has a marker of its own', () => {
    const marks = [1, 2, 4, 8, 16, 32, 64, 128, 256].map((mode) => {
      const f = fakeContext()
      drawOverlay(f.ctx, state({ cursor: { x: 113, y: 52 }, snap: { p: { x: 1, y: 0 }, mode } }), THEME, 5)
      return JSON.stringify(f.calls)
    })
    expect(new Set(marks).size).toBe(9)
  })
})
