import { describe, expect, it } from 'vitest'
import { fit, panBy, screenToWorld, type ViewState } from '../kernel/view'
import { attachInput, attachKeyboard, wheelFactor, type InputHost, type KeyboardHost } from './input'

const V0: ViewState = { cx: 100, cy: 50, scale: 2, width: 800, height: 600, dpr: 1 }
const EXTENTS = { minX: 0, minY: 0, maxX: 10, maxY: 10 }

function setup(rect = { left: 0, top: 0 }, extents: typeof EXTENTS | null = EXTENTS) {
  const target = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => rect,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  })
  let view = V0
  const clicks: [number, number, boolean][] = []
  const hovers: ({ x: number; y: number } | null)[] = []
  let enters = 0
  const host: InputHost = {
    getView: () => view,
    setView: (v) => (view = v),
    extents: () => extents,
    click: (sx, sy, shift) => clicks.push([sx, sy, shift]),
    enter: () => enters++,
    hover: (p) => hovers.push(p),
  }
  const dispose = attachInput(target as never, host)
  const fire = (type: string, fields: object, cancelable = false): Event => {
    const e = Object.assign(new Event(type, { cancelable }), fields)
    target.dispatchEvent(e)
    return e
  }
  return { fire, dispose, view: () => view, clicks, hovers, enters: () => enters }
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
    t.fire('pointermove', { clientX: 130, clientY: 80, buttons: 4 })
    t.fire('pointerup', { clientX: 130, clientY: 80 })
    expect(t.view()).toEqual(panBy(V0, 30, -20))
    t.fire('pointermove', { clientX: 200, clientY: 200, buttons: 4 })
    expect(t.view()).toEqual(panBy(V0, 30, -20))
  })

  it('ends the drag when the button is no longer pressed (lost capture)', () => {
    const t = setup()
    t.fire('pointerdown', { button: 1, pointerId: 1, clientX: 100, clientY: 100 })
    t.fire('pointermove', { clientX: 130, clientY: 80, buttons: 0 })
    expect(t.view()).toEqual(V0)
    t.fire('pointermove', { clientX: 200, clientY: 200, buttons: 4 })
    expect(t.view()).toEqual(V0)
  })

  it('left button clicks at the cursor, relative to the target, passing shift', () => {
    const t = setup({ left: 10, top: 40 })
    t.fire('pointerdown', { button: 0, pointerId: 1, clientX: 110, clientY: 140, shiftKey: false })
    t.fire('pointerdown', { button: 0, pointerId: 1, clientX: 15, clientY: 45, shiftKey: true })
    expect(t.clicks).toEqual([[100, 100, false], [5, 5, true]])
    expect(t.view()).toEqual(V0)
  })

  it('right button is Enter and the context menu is suppressed', () => {
    const t = setup()
    t.fire('pointerdown', { button: 2, pointerId: 1, clientX: 15, clientY: 45 })
    expect(t.enters()).toBe(1)
    expect(t.fire('contextmenu', {}, true).defaultPrevented).toBe(true)
    expect(t.clicks).toEqual([])
  })

  it('reports the cursor while it moves over the target, and null when it leaves', () => {
    const t = setup({ left: 10, top: 40 })
    t.fire('pointermove', { clientX: 30, clientY: 50, buttons: 0 })
    t.fire('pointerleave', {})
    expect(t.hovers).toEqual([{ x: 20, y: 10 }, null])
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
    t.fire('pointerdown', { button: 0, pointerId: 1, clientX: 1, clientY: 1 })
    t.fire('pointerdown', { button: 2, pointerId: 1, clientX: 1, clientY: 1 })
    expect(t.view()).toEqual(V0)
    expect(t.clicks).toEqual([])
    expect(t.enters()).toBe(0)
  })
})

function keyboard() {
  const target = new EventTarget()
  let buffer = ''
  const calls: string[] = []
  const host: KeyboardHost = {
    buffer: () => buffer,
    setBuffer: (s) => (buffer = s),
    submit: (s) => calls.push(`submit ${s}`),
    cancel: () => calls.push('cancel'),
    undo: () => calls.push('undo'),
    redo: () => calls.push('redo'),
    erase: () => calls.push('erase'),
    toggleHistory: () => calls.push('history'),
  }
  const dispose = attachKeyboard(target, host)
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}, from: object = {}): Event => {
    const e = Object.assign(new Event('keydown', { cancelable: true }), { key: k, ...mods })
    Object.defineProperty(e, 'target', { value: from })
    target.dispatchEvent(e)
    return e
  }
  const type = (text: string): void => {
    for (const ch of text) key(ch)
  }
  return { key, type, calls, buffer: () => buffer, dispose }
}

describe('attachKeyboard', () => {
  it('types into the buffer without focus; Enter and Space submit it', () => {
    const t = keyboard()
    t.type('L')
    expect(t.buffer()).toBe('L')
    expect(t.key('Enter').defaultPrevented).toBe(true)
    t.type('10,20')
    t.key(' ')
    expect(t.calls).toEqual(['submit L', 'submit 10,20'])
    expect(t.buffer()).toBe('')
  })

  it('Backspace edits, Esc clears and cancels', () => {
    const t = keyboard()
    t.type('@5<9')
    t.key('Backspace')
    expect(t.buffer()).toBe('@5<')
    t.key('Escape')
    expect(t.buffer()).toBe('')
    expect(t.calls).toEqual(['cancel'])
  })

  it('Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z, Del and F2', () => {
    const t = keyboard()
    t.key('z', { ctrlKey: true })
    t.key('Y', { ctrlKey: true })
    t.key('Z', { ctrlKey: true, shiftKey: true })
    t.key('z', { metaKey: true })
    t.key('Delete')
    t.key('F2')
    t.type('x')
    t.key('Delete') // with text typed, Del does not erase
    expect(t.calls).toEqual(['undo', 'redo', 'redo', 'undo', 'erase', 'history'])
  })

  it('leaves text fields, other shortcuts and Alt alone', () => {
    const t = keyboard()
    for (const field of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }]) {
      expect(t.key('a', {}, field).defaultPrevented).toBe(false)
    }
    expect(t.key('c', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(t.key('a', { altKey: true }).defaultPrevented).toBe(false)
    expect(t.key('Tab').defaultPrevented).toBe(false)
    expect(t.buffer()).toBe('')
    expect(t.calls).toEqual([])
  })

  it('dispose stops listening', () => {
    const t = keyboard()
    t.dispose()
    t.type('L')
    expect(t.buffer()).toBe('')
  })
})
