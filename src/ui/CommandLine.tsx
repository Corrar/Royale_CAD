import { ChevronUp } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import type { CommandLineState } from '../app/controller'
import type { Store } from '../app/stores'

const LINES_COLLAPSED = 3
const LINES_EXPANDED = 30

/**
 * The floating pill at the bottom: the last lines of history over the prompt and what is being typed. Typing
 * reaches it without focus (the keyboard router feeds the buffer); F2 or the chevron shows more history.
 */
export function CommandLine({ store, onToggleHistory }: { store: Store<CommandLineState>; onToggleHistory: () => void }) {
  const s = useSyncExternalStore(store.subscribe, store.get)
  const lines = s.history.slice(-(s.expanded ? LINES_EXPANDED : LINES_COLLAPSED))
  return (
    <section className={s.expanded ? 'cmdline expanded' : 'cmdline'} aria-label="Command line">
      {lines.length > 0 && (
        <ol className="cmdline-history" aria-live="polite">
          {lines.map((line, i) => (
            <li key={`${s.history.length - lines.length + i}:${line}`}>{line}</li>
          ))}
        </ol>
      )}
      <div className="cmdline-input">
        <span className="cmdline-prompt">{s.prompt}</span>
        <span className="cmdline-buffer">{s.buffer}</span>
        <span className="cmdline-caret" aria-hidden="true" />
        <button
          type="button"
          className="cmdline-toggle"
          aria-label="Command history (F2)"
          title="Command history (F2)"
          aria-expanded={s.expanded}
          onClick={onToggleHistory}
        >
          <ChevronUp size={14} aria-hidden="true" />
        </button>
      </div>
    </section>
  )
}
