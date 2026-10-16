/** What React's useSyncExternalStore reads: get() returns the same value until a subscriber is notified. */
export interface Store<T> {
  get(): T
  subscribe(fn: () => void): () => void
}

export interface WritableStore<T> extends Store<T> {
  set(value: T): void
}

interface Source {
  subscribe(fn: () => void): () => void
}

function listeners(): { add(fn: () => void): () => void; notify(): void } {
  const set = new Set<() => void>()
  return {
    add(fn) {
      const entry = (): void => fn()
      set.add(entry)
      return () => set.delete(entry)
    },
    notify() {
      for (const fn of [...set]) fn()
    },
  }
}

export function createStore<T>(initial: T): WritableStore<T> {
  let value = initial
  const l = listeners()
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return
      value = next
      l.notify()
    },
    subscribe: l.add,
  }
}

/** A value computed from sources, recomputed only when one of them notifies. */
export function derivedStore<T>(compute: () => T, ...sources: Source[]): Store<T> & { dispose(): void } {
  let value = compute()
  const l = listeners()
  const offs = sources.map((s) =>
    s.subscribe(() => {
      value = compute()
      l.notify()
    }),
  )
  return {
    get: () => value,
    subscribe: l.add,
    dispose() {
      for (const off of offs) off()
    },
  }
}
