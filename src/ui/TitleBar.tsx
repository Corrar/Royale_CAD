import { useEffect, useSyncExternalStore } from 'react'
import type { FileState } from '../app/files'
import type { Store } from '../app/stores'

/** The drawing's name, a dot while it has unsaved changes, and what a file operation under way is doing. */
export function TitleBar({ store }: { store: Store<FileState> }) {
  const { name, dirty, busy } = useSyncExternalStore(store.subscribe, store.get)
  const title = `${name}${dirty ? ' •' : ''} — Royale CAD`
  useEffect(() => {
    document.title = title
  }, [title])
  return (
    <header className="titlebar">
      <span>{title}</span>
      {busy && <span className="titlebar-busy" role="status">{busy}</span>}
    </header>
  )
}
