import { Settings } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import type { Setting, StatusState } from '../app/controller'
import type { Store } from '../app/stores'

const TOGGLES: { key: Setting; label: string; hint: string }[] = [
  { key: 'grid', label: 'GRID', hint: 'Grid (F7)' },
  { key: 'ortho', label: 'ORTHO', hint: 'Ortho mode (F8)' },
  { key: 'osnap', label: 'OSNAP', hint: 'Object snap (F3); right-click for its settings' },
]

const coordinate = (v: number | null): string => (v === null ? '—' : v.toFixed(4))

/**
 * Bottom right: where the cursor would land, the drafting toggles and the settings. Right-clicking OSNAP opens the
 * object snap settings, as in AutoCAD.
 */
export function StatusBar({ store, onToggle, onSettings }: { store: Store<StatusState>; onToggle: (setting: Setting) => void; onSettings: () => void }) {
  const s = useSyncExternalStore(store.subscribe, store.get)
  return (
    <section className="statusbar" aria-label="Status">
      <output className="statusbar-coords" aria-label="Cursor coordinates">
        {coordinate(s.x)}, {coordinate(s.y)}
      </output>
      {TOGGLES.map((t) => (
        <button
          key={t.key}
          type="button"
          className="statusbar-toggle"
          aria-pressed={s[t.key]}
          title={t.hint}
          onClick={() => onToggle(t.key)}
          onContextMenu={t.key === 'osnap' ? (e) => (e.preventDefault(), onSettings()) : undefined}
        >
          {t.label}
        </button>
      ))}
      <button type="button" className="statusbar-icon" aria-label="Settings" title="Settings (DS)" onClick={onSettings}>
        <Settings size={14} aria-hidden="true" />
      </button>
    </section>
  )
}
