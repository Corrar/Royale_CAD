import { useSyncExternalStore } from 'react'
import type { Setting, StatusState } from '../app/controller'
import type { Store } from '../app/stores'

const TOGGLES: { key: Setting; label: string; hint: string }[] = [
  { key: 'grid', label: 'GRID', hint: 'Grid (F7)' },
  { key: 'ortho', label: 'ORTHO', hint: 'Ortho mode (F8)' },
  { key: 'osnap', label: 'OSNAP', hint: 'Object snap (F3)' },
]

const coordinate = (v: number | null): string => (v === null ? '—' : v.toFixed(4))

/** Bottom right: where the cursor would land, and the drafting toggles. */
export function StatusBar({ store, onToggle }: { store: Store<StatusState>; onToggle: (setting: Setting) => void }) {
  const s = useSyncExternalStore(store.subscribe, store.get)
  return (
    <section className="statusbar" aria-label="Status">
      <output className="statusbar-coords" aria-label="Cursor coordinates">
        {coordinate(s.x)}, {coordinate(s.y)}
      </output>
      {TOGGLES.map((t) => (
        <button key={t.key} type="button" className="statusbar-toggle" aria-pressed={s[t.key]} title={t.hint} onClick={() => onToggle(t.key)}>
          {t.label}
        </button>
      ))}
    </section>
  )
}
