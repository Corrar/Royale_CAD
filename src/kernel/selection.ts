export interface Selection {
  /** The selected ids; read-only for callers. */
  readonly ids: ReadonlySet<number>
  set(ids: Iterable<number>): void
  add(ids: Iterable<number>): void
  remove(ids: Iterable<number>): void
  clear(): void
  /** Called after every call that changed the set. */
  onChange(fn: () => void): () => void
}

export function createSelection(): Selection {
  let ids = new Set<number>()
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const fn of [...listeners]) fn()
  }
  return {
    get ids() {
      return ids
    },
    set(next) {
      const s = new Set(next)
      if (s.size === ids.size && [...s].every((id) => ids.has(id))) return
      ids = s
      changed()
    },
    add(more) {
      const before = ids.size
      for (const id of more) ids.add(id)
      if (ids.size !== before) changed()
    },
    remove(less) {
      const before = ids.size
      for (const id of less) ids.delete(id)
      if (ids.size !== before) changed()
    },
    clear() {
      if (ids.size === 0) return
      ids = new Set()
      changed()
    },
    onChange(fn) {
      const entry = (): void => fn()
      listeners.add(entry)
      return () => listeners.delete(entry)
    },
  }
}
