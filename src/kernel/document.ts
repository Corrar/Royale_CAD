import { isColor, type Color } from './color'
import { typeOf } from './entity/registry'
import type { Entity } from './entity/types'
import { bboxFinite, bboxUnion, type BBox } from './geom/vec'

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
  /** Insertion order; an entity brought back by undo goes to the end. */
  entities(): IterableIterator<Entity>
  readonly size: number
  /** Runs fn as one undo step with one change event. If fn throws, nothing changes and the error propagates. */
  transact(label: string, fn: (tx: Tx) => void): void
  /** Returns the label of the step undone, or undefined when there is none. */
  undo(): string | undefined
  redo(): string | undefined
  onChange(fn: (c: Change) => void): () => void
  readonly layers: LayerTable
}

interface Step { label: string; before: Map<number, Entity | undefined>; after: Map<number, Entity | undefined> }

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
  const undoStack: Step[] = []
  const redoStack: Step[] = []
  let nextId = 1
  let count = 0
  // Original value of every id the open transaction touched; null when no transaction is open.
  let open: Map<number, Entity | undefined> | null = null

  const read = (id: number): Entity | undefined => {
    const e = items.get(id)
    return e === REMOVED ? undefined : e
  }

  function validate(e: Entity): void {
    const t = typeOf(e)
    if (!layers.get(e.layer)) throw new Error(`layer ${e.layer} does not exist`)
    if (e.color !== undefined && !isColor(e.color)) throw new Error(`invalid color ${e.color}`)
    const problem = t.validate?.(e)
    if (problem) throw new Error(problem)
    if (!bboxFinite(t.bbox(e))) throw new Error(`${e.type} has non-finite geometry`)
  }

  function touch(id: number): void {
    if (!open!.has(id)) open!.set(id, read(id))
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
      touch(e.id)
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
  function apply(from: Map<number, Entity | undefined>, to: Map<number, Entity | undefined>): Change {
    const c: Change = { added: [], removed: [], changed: [] }
    for (const [id, next] of to) {
      const prev = from.get(id)
      if (next) items.set(id, next)
      else items.delete(id)
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
    const s = from.pop()
    if (!s) return undefined
    to.push(s)
    emit(listeners, name === 'undo' ? apply(s.after, s.before) : apply(s.before, s.after))
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
      const startId = nextId
      const startCount = count
      open = touched
      try {
        fn(tx)
      } catch (error) {
        for (const [id, e] of touched) {
          if (e) items.set(id, e)
          else items.delete(id)
        }
        nextId = startId
        count = startCount
        throw error
      } finally {
        open = null
      }
      const c: Change = { added: [], removed: [], changed: [] }
      const before = new Map<number, Entity | undefined>()
      const after = new Map<number, Entity | undefined>()
      for (const [id, prev] of touched) {
        const next = read(id)
        if (items.get(id) === REMOVED) items.delete(id)
        if (prev === next) continue
        before.set(id, prev)
        after.set(id, next)
        if (!prev) c.added.push(next!)
        else if (!next) c.removed.push(prev)
        else c.changed.push([prev, next])
      }
      if (after.size === 0) return
      undoStack.push({ label, before, after })
      redoStack.length = 0
      emit(listeners, c)
    },
    undo: () => move(undoStack, redoStack, 'undo'),
    redo: () => move(redoStack, undoStack, 'redo'),
    onChange: (fn) => subscribe(listeners, fn),
    layers,
  }
}

/** Union of every entity's bbox; null for an empty document. */
export function docExtents(doc: Document): BBox | null {
  let box: BBox | null = null
  for (const e of doc.entities()) {
    const b = typeOf(e).bbox(e)
    box = box ? bboxUnion(box, b) : b
  }
  return box
}
