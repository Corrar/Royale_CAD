import { describe, expect, it } from 'vitest'
import { fit, panBy, screenToWorld, type ViewState } from '../kernel/view'
import { attachInput, wheelFactor, type InputHost } from './input'

const V0: ViewState = { cx: 100, cy: 50, scale: 2, width: 800, height: 600, dpr: 1 }
const EXTENTS = { minX: 0, minY: 0, maxX: 10, maxY: 10 }

function setup(rect = { left: 0, top: 0 }, extents: typeof EXTENTS | null = EXTENTS) {
  const target = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => rect,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  })
  let view = V0
  const host: InputHost = { getView: () => view, setView: (v) => (view = v), extents: () => extents }
  const dispose = attachInput(target as never, host)
  const fire = (type: string, fields: object, cancelable = false): Event => {
    const e = Object.assign(new Event(type, { cancelable }), fields)
    target.dispatchEvent(e)
    return e
  }
  return { fire, dispose, view: () => view }
}

describe('wheelFactor', () => {
  it('zooms in on forward scroll and is symmetric', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1)
    expect(wheelFactor(100)).toBeLessThan(1)
    expect(wheelFactor(0)).toBe(1)
    expect(wheelFactor(-100) * wheelFactor(100)).toBeCloseTo(1, 12)
  })
})

describe('attachInput', () => {
  it('wheel keeps the world point under the cursor', () => {
    const t = setup()
    const before = screenToWorld(V0, 300, 200)
    const e = t.fire('wheel', { deltaY: -100, clientX: 300, clientY: 200 }, true)
    const after = screenToWorld(t.view(), 300, 200)
    expect(Math.abs(after.x - before.x)).toBeLessThan(1e-6)
    expect(Math.abs(after.y - before.y)).toBeLessThan(1e-6)
    expect(t.view().scale).toBeGreaterThan(V0.scale)
    expect(e.defaultPrevented).toBe(true)
  })

  it('wheel anchor is relative to the target rect', () => {
    const t = setup({ left: 10, top: 40 })
    const before = screenToWorld(V0, 300, 200)
    t.fire('wheel', { deltaY: -100, clientX: 310, clientY: 240 }, true)
    const after = screenToWorld(t.view(), 300, 200)
    expect(Math.abs(after.x - before.x)).toBeLessThan(1e-6)
    expect(Math.abs(after.y - before.y)).toBeLessThan(1e-6)
  })

  it('middle button drags the view', () => {
    const t = setup()
    t.fire('pointerdown', { button: 1, pointerId: 1, clientX: 100, clientY: 100 })
    t.fire('pointermove', { clientX: 130, clientY: 80 })
    t.fire('pointerup', { clientX: 130, clientY: 80 })
    expect(t.view()).toEqual(panBy(V0, 30, -20))
    t.fire('pointermove', { clientX: 200, clientY: 200 })
    expect(t.view()).toEqual(panBy(V0, 30, -20))
  })

  it('other buttons do not drag', () => {
    const t = setup()
    t.fire('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    t.fire('pointermove', { clientX: 130, clientY: 80 })
    expect(t.view()).toEqual(V0)
  })

  it('middle double click fits the extents', () => {
    const t = setup()
    t.fire('auxclick', { button: 1, detail: 1 })
    expect(t.view()).toEqual(V0)
    t.fire('auxclick', { button: 1, detail: 2 })
    expect(t.view()).toEqual(fit(V0, EXTENTS, 64))
    const empty = setup({ left: 0, top: 0 }, null)
    empty.fire('auxclick', { button: 1, detail: 2 })
    expect(empty.view()).toEqual(V0)
  })

  it('dispose removes every listener', () => {
    const t = setup()
    t.dispose()
    t.fire('wheel', { deltaY: -100, clientX: 300, clientY: 200 }, true)
    t.fire('pointerdown', { button: 1, pointerId: 1, clientX: 100, clientY: 100 })
    t.fire('pointermove', { clientX: 130, clientY: 80 })
    t.fire('auxclick', { button: 1, detail: 2 })
    expect(t.view()).toEqual(V0)
  })
})
