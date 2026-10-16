import { RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react'
import type { SettingsActions, SettingsState, SettingsTab } from '../app/controller'
import { SNAP_NAMES } from '../app/settings'
import type { Store } from '../app/stores'
import { SNAP } from '../kernel/snap'

const MODE_LABELS: Readonly<Record<(typeof SNAP_NAMES)[number], string>> = {
  END: 'Endpoint', MID: 'Midpoint', CEN: 'Center', INT: 'Intersection', QUA: 'Quadrant', PER: 'Perpendicular',
  NEA: 'Nearest', NOD: 'Node', INS: 'Insertion',
}

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'osnap', label: 'Object Snap' },
  { key: 'aliases', label: 'Aliases' },
]

const ALL_MODES = SNAP_NAMES.reduce((m, n) => m | SNAP[n], 0)

function ObjectSnap({ modes, actions }: { modes: number; actions: SettingsActions }) {
  return (
    <div className="settings-body">
      <p className="settings-note">Points the cursor snaps to while a command asks for one. F3 turns object snap on and off.</p>
      <ul className="settings-modes">
        {SNAP_NAMES.map((n) => (
          <li key={n}>
            <label>
              <input type="checkbox" checked={(modes & SNAP[n]) !== 0} onChange={(e) => actions.setOsnap(e.target.checked ? modes | SNAP[n] : modes & ~SNAP[n])} />
              <span>{MODE_LABELS[n]}</span>
              <kbd>{n}</kbd>
            </label>
          </li>
        ))}
      </ul>
      <div className="settings-row">
        <button type="button" className="settings-button" onClick={() => actions.setOsnap(ALL_MODES)}>Select All</button>
        <button type="button" className="settings-button" onClick={() => actions.setOsnap(0)}>Clear All</button>
      </div>
    </div>
  )
}

function Aliases({ aliases, actions }: { aliases: Readonly<Record<string, string>>; actions: SettingsActions }) {
  const [alias, setAlias] = useState('')
  const [command, setCommand] = useState(actions.commands[0] ?? '')
  const [filter, setFilter] = useState('')
  const word = alias.trim().toUpperCase()
  const valid = /^[A-Z0-9_-]+$/.test(word)
  const add = (e: FormEvent): void => {
    e.preventDefault()
    if (!valid) return
    actions.setAlias(word, command)
    setAlias('')
  }
  const f = filter.trim().toUpperCase()
  const rows = Object.entries(aliases)
    .filter(([a, c]) => f === '' || a.includes(f) || c.includes(f))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return (
    <div className="settings-body">
      <form className="settings-row" onSubmit={add}>
        <input className="settings-input" aria-label="Alias" placeholder="Alias" value={alias} maxLength={16} onChange={(e) => setAlias(e.target.value)} />
        <select className="settings-input" aria-label="Command" value={command} onChange={(e) => setCommand(e.target.value)}>
          {actions.commands.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button type="submit" className="settings-button" disabled={!valid}>{word in aliases ? 'Change' : 'Add'}</button>
      </form>
      <input className="settings-input wide" aria-label="Filter aliases" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul className="settings-aliases" aria-label="Aliases">
        {rows.map(([a, c]) => (
          <li key={a}>
            <kbd>{a}</kbd>
            <span>{c}</span>
            <button type="button" className="settings-icon" aria-label={`Remove alias ${a}`} title={`Remove ${a}`} onClick={() => actions.setAlias(a, null)}>
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="settings-empty">No alias matches.</li>}
      </ul>
      <div className="settings-row">
        <button type="button" className="settings-button" onClick={actions.resetAliases}>
          <RotateCcw size={14} aria-hidden="true" /> Restore defaults
        </button>
      </div>
    </div>
  )
}

/** The settings (OSNAP, DSETTINGS, ALIASEDIT): object snap modes and command aliases, saved as they change. */
export function SettingsPanel({ store, actions }: { store: Store<SettingsState>; actions: SettingsActions }) {
  const s = useSyncExternalStore(store.subscribe, store.get, store.get)
  const id = useId()
  const dialog = useRef<HTMLElement>(null)
  // Opened, the focus goes in, so Tab and Esc work there at once.
  const open = s.open !== null
  useEffect(() => {
    if (open) dialog.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [open])
  if (s.open === null) return null
  const tab = s.open
  const keys = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      actions.show(null)
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (e.target as HTMLElement).getAttribute('role') === 'tab') {
      const next = TABS[(TABS.findIndex((t) => t.key === tab) + 1) % TABS.length]!.key
      actions.show(next)
      requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus())
    }
  }
  return (
    <section ref={dialog} className="settings" role="dialog" aria-labelledby={`${id}title`} onKeyDown={keys}>
      <header className="settings-head">
        <h2 id={`${id}title`}>Settings</h2>
        <div role="tablist" aria-label="Settings" className="settings-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`${id}${t.key}`}
              aria-selected={t.key === tab}
              aria-controls={`${id}panel`}
              tabIndex={t.key === tab ? 0 : -1}
              className="settings-tab"
              onClick={() => actions.show(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" className="settings-icon" aria-label="Close settings" title="Close (Esc)" onClick={() => actions.show(null)}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div id={`${id}panel`} role="tabpanel" aria-labelledby={`${id}${tab}`}>
        {tab === 'osnap' ? <ObjectSnap modes={s.settings.osnap} actions={actions} /> : <Aliases aliases={s.settings.aliases} actions={actions} />}
      </div>
    </section>
  )
}
