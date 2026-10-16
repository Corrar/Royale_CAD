import { isColor, type Color } from './color'
import { typeOf } from './entity/registry'
import type { Entity } from './entity/types'
import { bboxEmpty, bboxFinite, bboxUnion, type BBox } from './geom/vec'

/** An entity before the document gives it an id. */
export type Draft<E extends Entity = Entity> = E extends Entity ? Omit<E, 'id'> : never

export interface Tx {
  /** Stores a copy of the draft with a fresh id and returns it. */
  add(e: Draft): Entity
  /** Puts e in place of the stored entity with the same id. */
  replace(e: Entity): void
  remove(id: number): void
}

export interface Change { added: Entity[]; removed: Entity[]; changed: [before: Entity, after: Entity][] }

export interface Layer { readonly name: string; readonly color: Color; readonly visible: boolean; readonly locked: boolean }

export interface LayerTable {
  readonly size: number
  get(index: number): Layer | undefined
  /** Case-insensitive, like AutoCAD; -1 when absent. */
  indexOf(name: string): number
  add(layer: Layer): number
  update(index: number, patch: Partial<Layer>): void
  onChange(fn: (index: number) => void): () => void
}

export interface Document {
  get(id: number): Entity | undefined
  /** Insertion order; an entity brought back by undo goes to the end. Ids are positive integers given in
   *  increasing order and never reused. */
  entities(): IterableIterator<Entity>
  readonly size: number
  /** Runs fn as one undo step with one change event. If fn throws, nothing changes and the error propagates. */
  transact(label: string, fn: (tx: Tx) => void): void
  /** Returns the label of the step undone, or undefined when there is none. */
  undo(): string | undefined
  redo(): string | undefined
  /**
   * Until the matching endGroup, committed transactions merge into one undo step labelled `label` (a command).
   * Inside a group, undo stops at the group's start, and what it takes back cannot be redone after the group.
   * Groups nest; only the outermost pair counts.
   */
  beginGroup(label: string): void
  endGroup(): void
  onChange(fn: (c: Change) => void): () => void
  /** Forgets every undo and redo step: a drawing just read starts with nothing to undo. Not inside a group. */
  clearHistory(): void
  readonly layers: LayerTable
}

/** Entity ids[k] went from before[k] to after[k]; undefined means absent. */
interface Step { label: string; ids: number[]; before: (Entity | undefined)[]; after: (Entity | undefined)[] }

/** Calls every listener even if one throws, then rethrows the first error. */
function emit<T>(listeners: Set<(x: T) => void>, x: T): void {
  let failed = false
  let first: unknown
  for (const fn of [...listeners]) {
    try {
      fn(x)
    } catch (error) {
      if (!failed) first = error
      failed = true
    }
  }
  if (failed) throw first
}

/**
 * emit, in commit order: a change committed by a listener (a transaction or an undo from inside onChange) waits
 * until every listener has seen the change being delivered.
 */
function orderedEmitter<T>(listeners: Set<(x: T) => void>): (x: T) => void {
  const queue: T[] = []
  let delivering = false
  return (x) => {
    queue.push(x)
    if (delivering) return
    delivering = true
    let failed = false
    let first: unknown
    try {
      while (queue.length > 0) {
        try {
          emit(listeners, queue.shift()!)
        } catch (error) {
          if (!failed) first = error
          failed = true
        }
      }
    } finally {
      delivering = false
    }
    if (failed) throw first
  }
}

function subscribe<T>(listeners: Set<(x: T) => void>, fn: (x: T) => void): () => void {
  const entry = (x: T): void => fn(x)
  listeners.add(entry)
  return () => listeners.delete(entry)
}

const INVALID_NAME = /[<>/\\":;?*|,=`]/

function createLayerTable(): LayerTable {
  const layers: Layer[] = [{ name: '0', color: 7, visible: true, locked: false }]
  const listeners = new Set<(index: number) => void>()

  const indexOf = (name: string): number => {
    const key = name.toLowerCase()
    return layers.findIndex((l) => l.name.toLowerCase() === key)
  }
  const check = (l: Layer, self: number): void => {
    if (typeof l.name !== 'string' || l.name.trim() === '' || INVALID_NAME.test(l.name)) throw new Error(`invalid layer name "${l.name}"`)
    const other = indexOf(l.name)
    if (other !== -1 && other !== self) throw new Error(`layer "${l.name}" already exists`)
    if (!isColor(l.color)) throw new Error(`invalid layer color ${l.color}`)
  }

  return {
    get size() {
      return layers.length
    },
    get: (index) => layers[index],
    indexOf,
    add(layer) {
      const l = { name: layer.name, color: layer.color, visible: layer.visible, locked: layer.locked }
      check(l, -1)
      layers.push(l)
      emit(listeners, layers.length - 1)
      return layers.length - 1
    },
    update(index, patch) {
      const prev = layers[index]
      if (!prev) throw new Error(`no layer ${index}`)
      const next = { ...prev, ...patch }
      if (index === 0 && next.name !== '0') throw new Error('layer 0 cannot be renamed')
      check(next, index)
      layers[index] = next
      emit(listeners, index)
    },
    onChange: (fn) => subscribe(listeners, fn),
  }
}

// Marks an entity removed by the open transaction: its key stays, so a rollback keeps the iteration order.
const REMOVED = Symbol('removed')

export function createDocument(): Document {
  const items = new Map<number, Entity | typeof REMOVED>()
  const layers = createLayerTable()
  const listeners = new Set<(c: Change) => void>()
  const deliver = orderedEmitter(listeners)
  const undoStack: Step[] = []
  const redoStack: Step[] = []
  let nextId = 1
  let count = 0
  // Original value of every pre-existing id the open transaction touched; null when no transaction is open.
  // Ids from txStart on were created by the transaction, so their original value is known to be absent.
  let open: Map<number, Entity | undefined> | null = null
  let txStart = 0
  // The open undo group: its depth, label, first step in undoStack, and how many steps it moved to redoStack.
  let groupDepth = 0
  let groupLabel = ''
  let groupStart = 0
  let groupUndone = 0

  const read = (id: number): Entity | undefined => {
    const e = items.get(id)
    return e === REMOVED ? undefined : e
  }

  /** Every number and every element of a Float64Array field; bboxes alone miss a NaN that bboxAdd skips. */
  function finite(e: Entity): boolean {
    const fields = e as unknown as Record<string, unknown>
    for (const k in fields) {
      const v = fields[k]
      if (typeof v === 'number' ? !Number.isFinite(v) : v instanceof Float64Array && !v.every(Number.isFinite)) return false
    }
    return true
  }

  function validate(e: Entity): void {
    const t = typeOf(e)
    if (!layers.get(e.layer)) throw new Error(`layer ${e.layer} does not exist`)
    if (e.color !== undefined && !isColor(e.color)) throw new Error(`invalid color ${e.color}`)
    const problem = t.validate?.(e)
    if (problem) throw new Error(problem)
    const b = t.bbox(e)
    if (!finite(e) || !(bboxFinite(b) || bboxEmpty(b))) throw new Error(`${e.type} has non-finite geometry`)
  }

  function touch(id: number): void {
    if (id < txStart && !open!.has(id)) open!.set(id, read(id))
  }

  // tx outlives its transaction if a caller keeps it.
  const live = (): void => {
    if (!open) throw new Error('the transaction is closed')
  }

  const tx: Tx = {
    add(draft) {
      live()
      const e = { ...draft, id: nextId } as Entity
      validate(e)
      nextId++
      items.set(e.id, e)
      count++
      return e
    },
    replace(e) {
      live()
      if (!read(e.id)) throw new Error(`no entity ${e.id}`)
      validate(e)
      touch(e.id)
      items.set(e.id, e)
    },
    remove(id) {
      live()
      if (!read(id)) throw new Error(`no entity ${id}`)
      touch(id)
      items.set(id, REMOVED)
      count--
    },
  }

  /** Writes the entities of `to` (undefined: absent) and returns the change from the state `from`. */
  function apply(ids: readonly number[], from: readonly (Entity | undefined)[], to: readonly (Entity | undefined)[]): Change {
    const c: Change = { added: [], removed: [], changed: [] }
    for (let k = 0; k < ids.length; k++) {
      const prev = from[k]
      const next = to[k]
      if (next) items.set(ids[k]!, next)
      else items.delete(ids[k]!)
      if (!prev) {
        c.added.push(next!)
        count++
      } else if (!next) {
        c.removed.push(prev)
        count--
      } else c.changed.push([prev, next])
    }
    return c
  }

  function move(from: Step[], to: Step[], name: 'undo' | 'redo'): string | undefined {
    if (open) throw new Error(`${name} cannot run inside a transaction`)
    if (groupDepth > 0) {
      if (name === 'undo' ? undoStack.length <= groupStart : groupUndone === 0) return undefined
      groupUndone += name === 'undo' ? 1 : -1
    }
    const s = from.pop()
    if (!s) return undefined
    to.push(s)
    deliver(name === 'undo' ? apply(s.ids, s.after, s.before) : apply(s.ids, s.before, s.after))
    return s.label
  }

  return {
    get: read,
    *entities() {
      for (const e of items.values()) if (e !== REMOVED) yield e
    },
    get size() {
      return count
    },
    transact(label, fn) {
      if (open) throw new Error('transact cannot be nested')
      const touched = new Map<number, Entity | undefined>()
      const startCount = count
      txStart = nextId
      open = touched
      try {
        fn(tx)
      } catch (error) {
        for (const [id, e] of touched) items.set(id, e!) // only ids that existed: e is never undefined
        for (let id = txStart; id < nextId; id++) items.delete(id)
        nextId = txStart
        count = startCount
        throw error
      } finally {
        open = null
      }
      const c: Change = { added: [], removed: [], changed: [] }
      const step: Step = { label, ids: [], before: [], after: [] }
      const record = (id: number, prev: Entity | undefined): void => {
        const raw = items.get(id)
        const next = raw === REMOVED ? undefined : raw
        if (raw === REMOVED) items.delete(id)
        if (prev === next) return
        step.ids.push(id)
        step.before.push(prev)
        step.after.push(next)
        if (!prev) c.added.push(next!)
        else if (!next) c.removed.push(prev)
        else c.changed.push([prev, next])
      }
      for (const [id, prev] of touched) record(id, prev)
      for (let id = txStart; id < nextId; id++) record(id, undefined)
      if (step.ids.length === 0) return
      undoStack.push(step)
      redoStack.length = 0
      groupUndone = 0
      deliver(c)
    },
    undo: () => move(undoStack, redoStack, 'undo'),
    clearHistory() {
      if (open || groupDepth > 0) throw new Error('clearHistory cannot run inside a transaction or a group')
      undoStack.length = 0
      redoStack.length = 0
    },
    redo: () => move(redoStack, undoStack, 'redo'),
    beginGroup(label) {
      if (open) throw new Error('beginGroup cannot run inside a transaction')
      if (groupDepth++ > 0) return
      groupLabel = label
      groupStart = undoStack.length
      groupUndone = 0
    },
    endGroup() {
      if (groupDepth === 0) throw new Error('endGroup: no group is open')
      if (--groupDepth > 0) return
      // What was undone inside the group sits on top of the redo stack; it only made sense inside the command.
      redoStack.length -= groupUndone
      groupUndone = 0
      const steps = undoStack.splice(groupStart)
      // Net change per entity, in first-touch order: the earliest before against the latest after.
      const merged: Step = { label: groupLabel, ids: [], before: [], after: [] }
      const slot = new Map<number, number>()
      for (const s of steps) {
        for (let k = 0; k < s.ids.length; k++) {
          const id = s.ids[k]!
          const at = slot.get(id)
          if (at === undefined) {
            slot.set(id, merged.ids.length)
            merged.ids.push(id)
            merged.before.push(s.before[k])
            merged.after.push(s.after[k])
          } else merged.after[at] = s.after[k]
        }
      }
      const keep = merged.ids.map((_, k) => merged.before[k] !== merged.after[k])
      const net: Step = {
        label: groupLabel,
        ids: merged.ids.filter((_, k) => keep[k]),
        before: merged.before.filter((_, k) => keep[k]),
        after: merged.after.filter((_, k) => keep[k]),
      }
      if (net.ids.length > 0) undoStack.push(net)
    },
    onChange: (fn) => subscribe(listeners, fn),
    layers,
  }
}

/** Union of every entity's bbox; null when no entity has geometry. */
export function docExtents(doc: Document): BBox | null {
  let box: BBox | null = null
  for (const e of doc.entities()) {
    const b = typeOf(e).bbox(e)
    if (bboxEmpty(b)) continue
    box = box ? bboxUnion(box, b) : b
  }
  return box
}
