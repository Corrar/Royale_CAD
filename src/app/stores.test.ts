import { describe, expect, it } from 'vitest'
import { createStore, derivedStore } from './stores'

describe('createStore', () => {
  it('notifies on a new value only', () => {
    const s = createStore(1)
    let n = 0
    const off = s.subscribe(() => n++)
    s.set(1)
    s.set(2)
    expect([s.get(), n]).toEqual([2, 1])
    off()
    s.set(3)
    expect(n).toBe(1)
  })
})

describe('derivedStore', () => {
  it('keeps the same snapshot until a source notifies, then recomputes once', () => {
    const a = createStore(1)
    const b = createStore(10)
    let computed = 0
    const d = derivedStore(() => {
      computed++
      return { sum: a.get() + b.get() }
    }, a, b)
    const first = d.get()
    expect(d.get()).toBe(first)
    let n = 0
    d.subscribe(() => n++)
    a.set(2)
    expect(d.get()).toEqual({ sum: 12 })
    expect(d.get()).not.toBe(first)
    expect([computed, n]).toEqual([2, 1])
    d.dispose()
    b.set(20)
    expect(n).toBe(1)
  })
})
