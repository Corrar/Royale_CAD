import { describe, expect, it } from 'vitest'
import { createSelection } from './selection'

function setup() {
  const s = createSelection()
  let events = 0
  s.onChange(() => events++)
  return { s, events: () => events, ids: () => [...s.ids].sort((a, b) => a - b) }
}

describe('createSelection', () => {
  it('adds, removes, sets and clears', () => {
    const t = setup()
    t.s.add([3, 1])
    expect(t.ids()).toEqual([1, 3])
    t.s.remove([3, 9])
    expect(t.ids()).toEqual([1])
    t.s.set([5, 6])
    expect(t.ids()).toEqual([5, 6])
    t.s.clear()
    expect(t.ids()).toEqual([])
    expect(t.events()).toBe(4)
  })

  it('notifies only when the set changes', () => {
    const t = setup()
    t.s.add([1, 2])
    t.s.add([2, 1])
    t.s.remove([7])
    t.s.set([2, 1])
    t.s.clear()
    t.s.clear()
    expect(t.events()).toBe(2)
  })

  it('unsubscribes', () => {
    const s = createSelection()
    let n = 0
    const off = s.onChange(() => n++)
    off()
    s.add([1])
    expect(n).toBe(0)
  })
})
