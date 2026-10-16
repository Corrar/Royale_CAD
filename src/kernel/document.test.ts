import { describe, expect, it } from 'vitest'
import { TRUE_COLOR } from './color'
import { createDocument, docExtents, type Change, type Document, type Tx } from './document'
import type { Entity, Line } from './entity/types'

const L = (x0: number, y0: number, x1: number, y1: number) => ({ type: 'line', layer: 0, x0, y0, x1, y1 }) as const

function setup() {
  const doc = createDocument()
  const events: Change[] = []
  doc.onChange((c) => events.push(c))
  return { doc, events }
}

const ids = (es: readonly Entity[]): number[] => es.map((e) => e.id)
const all = (doc: Document): Entity[] => [...doc.entities()]

describe('createDocument', () => {
  it('starts empty with layer 0', () => {
    const doc = createDocument()
    expect(doc.size).toBe(0)
    expect(all(doc)).toEqual([])
    expect(doc.layers.size).toBe(1)
    expect(doc.layers.get(0)).toEqual({ name: '0', color: 7, visible: true, locked: false })
    expect(doc.undo()).toBeUndefined()
    expect(doc.redo()).toBeUndefined()
  })

  it('assigns increasing ids and stores what add returns', () => {
    const { doc } = setup()
    let a!: Entity, b!: Entity
    doc.transact('LINE', (tx) => {
      a = tx.add(L(0, 0, 1, 0))
      b = tx.add(L(1, 0, 1, 1))
    })
    expect(b.id).toBeGreaterThan(a.id)
    expect(doc.get(a.id)).toBe(a)
    expect(a).toMatchObject(L(0, 0, 1, 0))
    expect(doc.size).toBe(2)
    expect(all(doc)).toEqual([a, b])
  })

  it('emits one event per transaction with all of its changes', () => {
    const { doc, events } = setup()
    let a!: Entity, b!: Entity
    doc.transact('setup', (tx) => {
      a = tx.add(L(0, 0, 1, 0))
      b = tx.add(L(0, 0, 2, 0))
    })
    let c!: Entity
    const moved = { ...a, x1: 5 } as Line
    doc.transact('mixed', (tx) => {
      c = tx.add(L(0, 0, 3, 0))
      tx.replace(moved)
      tx.remove(b.id)
    })
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({ added: [c], removed: [b], changed: [[a, moved]] })
  })

  it('reads inside a transaction see its own writes', () => {
    const { doc } = setup()
    doc.transact('t', (tx) => {
      const a = tx.add(L(0, 0, 1, 0))
      expect(doc.get(a.id)).toBe(a)
      expect(doc.size).toBe(1)
      tx.remove(a.id)
      expect(doc.get(a.id)).toBeUndefined()
      expect(doc.size).toBe(0)
      expect(all(doc)).toEqual([])
    })
  })

  it('coalesces several changes to one entity inside a transaction', () => {
    const { doc, events } = setup()
    let a!: Entity, b!: Entity
    doc.transact('setup', (tx) => {
      a = tx.add(L(0, 0, 1, 0))
      b = tx.add(L(0, 0, 2, 0))
    })
    const a1 = { ...a, x1: 7 } as Line
    const a2 = { ...a, x1: 8 } as Line
    let fresh!: Entity
    const fresh2 = (): Entity => ({ ...fresh, x1: 9 }) as Line
    let last!: Entity
    doc.transact('t', (tx) => {
      tx.replace(a1)
      tx.replace(a2) // replace + replace = one change from the original
      tx.replace({ ...b, x1: 3 } as Line)
      tx.remove(b.id) // replace + remove = removal of the original
      fresh = tx.add(L(5, 5, 6, 6))
      last = fresh2()
      tx.replace(last) // add + replace = addition of the final object
      tx.remove(tx.add(L(1, 1, 2, 2)).id) // add + remove = nothing
    })
    expect(events[1]).toEqual({ added: [last], removed: [b], changed: [[a, a2]] })
  })

  it('a transaction without net changes emits nothing and is not an undo step', () => {
    const { doc, events } = setup()
    let a!: Entity
    doc.transact('setup', (tx) => {
      a = tx.add(L(0, 0, 1, 0))
    })
    doc.transact('empty', () => {})
    doc.transact('noop', (tx) => {
      tx.replace({ ...a, x1: 2 } as Line)
      tx.replace(a)
    })
    expect(events).toHaveLength(1)
    expect(doc.undo()).toBe('setup')
  })

  it('undo restores the same objects and emits the inverse change; redo reapplies them', () => {
    const { doc, events } = setup()
    let a!: Entity, b!: Entity
    doc.transact('setup', (tx) => {
      a = tx.add(L(0, 0, 1, 0))
      b = tx.add(L(0, 0, 2, 0))
    })
    const moved = { ...a, x1: 5 } as Line
    let c!: Entity
    doc.transact('edit', (tx) => {
      tx.replace(moved)
      tx.remove(b.id)
      c = tx.add(L(0, 0, 3, 0))
    })
    expect(doc.undo()).toBe('edit')
    expect(doc.get(a.id)).toBe(a)
    expect(doc.get(b.id)).toBe(b)
    expect(doc.get(c.id)).toBeUndefined()
    expect(events.at(-1)).toEqual({ added: [b], removed: [c], changed: [[moved, a]] })
    expect(doc.redo()).toBe('edit')
    expect(doc.get(a.id)).toBe(moved)
    expect(doc.get(b.id)).toBeUndefined()
    expect(doc.get(c.id)).toBe(c)
    expect(events.at(-1)).toEqual({ added: [c], removed: [b], changed: [[a, moved]] })
    expect(doc.size).toBe(2)
  })

  it('undo walks back step by step and stops at the start', () => {
    const { doc } = setup()
    doc.transact('one', (tx) => void tx.add(L(0, 0, 1, 0)))
    doc.transact('two', (tx) => void tx.add(L(0, 0, 2, 0)))
    expect(doc.undo()).toBe('two')
    expect(doc.undo()).toBe('one')
    expect(doc.undo()).toBeUndefined()
    expect(doc.size).toBe(0)
    expect(doc.redo()).toBe('one')
    expect(doc.size).toBe(1)
  })

  it('a new transaction clears the redo stack', () => {
    const { doc } = setup()
    doc.transact('one', (tx) => void tx.add(L(0, 0, 1, 0)))
    doc.undo()
    doc.transact('two', (tx) => void tx.add(L(0, 0, 2, 0)))
    expect(doc.redo()).toBeUndefined()
    expect(doc.size).toBe(1)
  })

  it('an exception inside transact changes nothing', () => {
    const { doc, events } = setup()
    let a!: Entity, b!: Entity
    doc.transact('setup', (tx) => {
      a = tx.add(L(0, 0, 1, 0))
      b = tx.add(L(0, 0, 2, 0))
    })
    const before = all(doc)
    const boom = new Error('boom')
    expect(() =>
      doc.transact('fail', (tx) => {
        tx.remove(a.id)
        tx.replace({ ...b, x1: 9 } as Line)
        tx.add(L(4, 4, 5, 5))
        throw boom
      }),
    ).toThrow(boom)
    expect(all(doc)).toEqual(before)
    expect(doc.get(a.id)).toBe(a)
    expect(doc.get(b.id)).toBe(b)
    expect(doc.size).toBe(2)
    expect(events).toHaveLength(1)
    expect(doc.undo()).toBe('setup')
    // Ids taken by the failed transaction are given out again.
    doc.redo()
    let c!: Entity
    doc.transact('next', (tx) => {
      c = tx.add(L(0, 0, 3, 0))
    })
    expect(c.id).toBe(b.id + 1)
  })

  it('rejects invalid entities and unknown ids, leaving the document intact', () => {
    const { doc, events } = setup()
    let a!: Entity
    doc.transact('setup', (tx) => {
      a = tx.add(L(0, 0, 1, 0))
    })
    const cases: Array<[string, (tx: Tx) => void]> = [
      ['layer', (tx) => tx.add({ ...L(0, 0, 1, 0), layer: 3 })],
      ['color', (tx) => tx.add({ ...L(0, 0, 1, 0), color: 0 })],
      ['color', (tx) => tx.add({ ...L(0, 0, 1, 0), color: TRUE_COLOR * 2 })],
      ['finite', (tx) => tx.add(L(0, 0, NaN, 0))],
      ['finite', (tx) => tx.add({ type: 'circle', layer: 0, cx: 0, cy: 0, r: Infinity })],
      ['radius', (tx) => tx.add({ type: 'circle', layer: 0, cx: 0, cy: 0, r: -1 })],
      ['vertices', (tx) => tx.add({ type: 'polyline', layer: 0, pts: new Float64Array(0), bulges: null, closed: false })],
      ['vertices', (tx) => tx.add({ type: 'polyline', layer: 0, pts: new Float64Array(3), bulges: null, closed: false })],
      ['bulges', (tx) => tx.add({ type: 'polyline', layer: 0, pts: new Float64Array(4), bulges: new Float64Array(1), closed: false })],
      ['finite', (tx) => tx.add({ type: 'arc', layer: 0, cx: 0, cy: 0, r: 1, a0: 0, a1: NaN })],
      ['finite', (tx) => tx.add({ type: 'arc', layer: 0, cx: 0, cy: 0, r: 1, a0: 0, a1: Infinity })],
      ['finite', (tx) => tx.add({ type: 'polyline', layer: 0, pts: new Float64Array([0, 0, NaN, NaN, 1, 1]), bulges: null, closed: false })],
      ['finite', (tx) => tx.add({ type: 'polyline', layer: 0, pts: new Float64Array(4), bulges: new Float64Array([0, NaN]), closed: false })],
      ['unregistered', (tx) => tx.add({ ...L(0, 0, 1, 0), type: 'nope' } as never)],
      ['no entity', (tx) => tx.replace({ ...a, id: 99 })],
      ['no entity', (tx) => tx.remove(99)],
      ['no entity', (tx) => {
        tx.remove(a.id)
        tx.remove(a.id)
      }],
    ]
    for (const [message, fn] of cases) {
      expect(() => doc.transact('bad', fn), message).toThrow(new RegExp(message))
    }
    expect(all(doc)).toEqual([a])
    expect(events).toHaveLength(1)
  })

  it('a tx kept after its transaction refuses to write', () => {
    const { doc } = setup()
    let kept!: Tx
    doc.transact('t', (tx) => {
      kept = tx
    })
    expect(() => kept.add(L(0, 0, 1, 0))).toThrow(/closed/)
    expect(doc.size).toBe(0)
  })

  it('transact cannot be nested, and undo or redo cannot run inside one', () => {
    const { doc } = setup()
    expect(() => doc.transact('outer', () => doc.transact('inner', () => {}))).toThrow(/nested/)
    expect(() => doc.transact('t', () => doc.undo())).toThrow(/inside a transaction/)
    expect(() => doc.transact('t', () => doc.redo())).toThrow(/inside a transaction/)
    doc.transact('after', (tx) => void tx.add(L(0, 0, 1, 0)))
    expect(doc.size).toBe(1)
  })

  it('a listener that commits its own change does not reorder the events for later listeners', () => {
    const doc = createDocument()
    doc.onChange((c) => {
      for (const e of c.added) {
        if (e.type === 'line' && e.x0 === 0) doc.transact('shift', (tx) => tx.replace({ ...e, x0: 100, x1: 101 }))
      }
    })
    const seen: string[] = []
    doc.onChange((c) => {
      for (const e of c.added) seen.push(`added ${(e as Line).x0}`)
      for (const [, e] of c.changed) seen.push(`changed ${(e as Line).x0}`)
    })
    doc.transact('add', (tx) => void tx.add(L(0, 0, 1, 0)))
    expect(seen).toEqual(['added 0', 'changed 100'])
  })

  it('a throwing listener does not starve the others, and the change still commits', () => {
    const doc = createDocument()
    const seen: number[] = []
    doc.onChange(() => {
      throw new Error('listener')
    })
    const off = doc.onChange((c) => seen.push(c.added.length))
    expect(() => doc.transact('t', (tx) => void tx.add(L(0, 0, 1, 0)))).toThrow('listener')
    expect(seen).toEqual([1])
    expect(doc.size).toBe(1)
    off()
    expect(() => doc.undo()).toThrow('listener')
    expect(seen).toEqual([1])
  })
})

describe('undo groups', () => {
  it('merges the transactions of a group into one undo step with the group label', () => {
    const { doc, events } = setup()
    doc.beginGroup('LINE')
    doc.transact('seg', (tx) => void tx.add(L(0, 0, 1, 0)))
    doc.transact('seg', (tx) => void tx.add(L(1, 0, 1, 1)))
    doc.endGroup()
    expect(events).toHaveLength(2) // each transaction still notifies at once
    expect(doc.size).toBe(2)
    expect(doc.undo()).toBe('LINE')
    expect(doc.size).toBe(0)
    expect(events.at(-1)!.removed).toHaveLength(2)
    expect(doc.redo()).toBe('LINE')
    expect(doc.size).toBe(2)
  })

  it('undo inside a group stops at the group start, and what it took back cannot be redone after', () => {
    const { doc } = setup()
    doc.transact('before', (tx) => void tx.add(L(5, 5, 6, 6)))
    doc.beginGroup('LINE')
    doc.transact('seg', (tx) => void tx.add(L(0, 0, 1, 0)))
    doc.transact('seg', (tx) => void tx.add(L(1, 0, 1, 1)))
    expect(doc.undo()).toBe('seg')
    expect(doc.undo()).toBe('seg')
    expect(doc.undo()).toBeUndefined() // 'before' belongs to the previous command
    expect(doc.size).toBe(1)
    doc.endGroup()
    expect(doc.redo()).toBeUndefined()
    expect(doc.undo()).toBe('before')
  })

  it('nets the changes of the group per entity, and an empty group leaves no step', () => {
    const { doc } = setup()
    let a!: Entity
    doc.transact('setup', (tx) => {
      a = tx.add(L(0, 0, 1, 0))
    })
    doc.beginGroup('EMPTY')
    doc.endGroup()
    doc.beginGroup('NET')
    let b!: Entity
    doc.transact('add', (tx) => {
      b = tx.add(L(9, 9, 9, 9))
    })
    doc.transact('move', (tx) => tx.replace({ ...a, x1: 2 } as Line))
    doc.transact('move', (tx) => tx.replace({ ...a, x1: 3 } as Line))
    doc.transact('erase', (tx) => tx.remove(b.id))
    doc.endGroup()
    expect(doc.undo()).toBe('NET')
    expect(doc.get(a.id)).toBe(a)
    expect(doc.undo()).toBe('setup')
  })

  it('nests: only the outermost pair counts', () => {
    const { doc } = setup()
    doc.beginGroup('OUTER')
    doc.transact('one', (tx) => void tx.add(L(0, 0, 1, 0)))
    doc.beginGroup('INNER')
    doc.transact('two', (tx) => void tx.add(L(0, 0, 2, 0)))
    doc.endGroup()
    doc.endGroup()
    expect(doc.undo()).toBe('OUTER')
    expect(doc.size).toBe(0)
  })

  it('refuses unbalanced or misplaced calls', () => {
    const { doc } = setup()
    expect(() => doc.endGroup()).toThrow(/no group/)
    expect(() => doc.transact('t', () => doc.beginGroup('x'))).toThrow(/inside a transaction/)
  })
})

describe('layers', () => {
  it('adds layers with unique case-insensitive names and finds them', () => {
    const doc = createDocument()
    const i = doc.layers.add({ name: 'Walls', color: 1, visible: true, locked: false })
    expect(i).toBe(1)
    expect(doc.layers.indexOf('WALLS')).toBe(1)
    expect(doc.layers.indexOf('nope')).toBe(-1)
    expect(() => doc.layers.add({ name: 'walls', color: 2, visible: true, locked: false })).toThrow(/exists/)
  })

  it('validates names and colors', () => {
    const doc = createDocument()
    for (const name of ['', '  ', 'a/b', 'a*b', 'a,b']) {
      expect(() => doc.layers.add({ name, color: 7, visible: true, locked: false }), name).toThrow(/name/)
    }
    expect(() => doc.layers.add({ name: 'x', color: 0, visible: true, locked: false })).toThrow(/color/)
  })

  it('update replaces the record and notifies with the index', () => {
    const doc = createDocument()
    const seen: number[] = []
    doc.layers.onChange((i) => seen.push(i))
    const i = doc.layers.add({ name: 'A', color: 1, visible: true, locked: false })
    const before = doc.layers.get(i)
    doc.layers.update(i, { color: 3, visible: false })
    expect(doc.layers.get(i)).toEqual({ name: 'A', color: 3, visible: false, locked: false })
    expect(before).toEqual({ name: 'A', color: 1, visible: true, locked: false })
    expect(seen).toEqual([1, 1])
  })

  it('layer 0 keeps its name; renames stay unique; unknown indices throw', () => {
    const doc = createDocument()
    doc.layers.add({ name: 'A', color: 1, visible: true, locked: false })
    expect(() => doc.layers.update(0, { name: 'Zero' })).toThrow(/layer 0/)
    expect(() => doc.layers.update(1, { name: 'a' })).not.toThrow()
    expect(() => doc.layers.update(1, { name: '0' })).toThrow(/exists/)
    expect(() => doc.layers.update(5, { color: 1 })).toThrow(/no layer/)
  })
})

describe('docExtents', () => {
  it('is null when empty and the union of the bboxes otherwise', () => {
    const doc = createDocument()
    expect(docExtents(doc)).toBeNull()
    doc.transact('t', (tx) => {
      tx.add(L(0, 0, 10, 5))
      tx.add({ type: 'circle', layer: 0, cx: 20, cy: 0, r: 3 })
    })
    expect(docExtents(doc)).toEqual({ minX: 0, minY: -3, maxX: 23, maxY: 5 })
  })

  it('leaves out what has no geometry: opaque entities alone have no extents', () => {
    const doc = createDocument()
    doc.transact('t', (tx) => void tx.add({ type: 'opaque', layer: 0, name: 'HATCH', raw: '  0\nHATCH\n' }))
    expect(docExtents(doc)).toBeNull()
    doc.transact('t', (tx) => void tx.add(L(0, 0, 1, 1)))
    expect(docExtents(doc)).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 })
  })
})

describe('clearHistory', () => {
  it('leaves nothing to undo or redo, and is refused inside a group', () => {
    const doc = createDocument()
    doc.transact('a', (tx) => void tx.add(L(0, 0, 1, 1)))
    doc.transact('b', (tx) => void tx.add(L(0, 0, 2, 2)))
    doc.undo()
    doc.clearHistory()
    expect(doc.undo()).toBeUndefined()
    expect(doc.redo()).toBeUndefined()
    expect(doc.size).toBe(1)
    doc.beginGroup('G')
    expect(() => doc.clearHistory()).toThrow(/inside a transaction or a group/)
    doc.endGroup()
  })
})
