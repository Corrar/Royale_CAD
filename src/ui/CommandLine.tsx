import { ChevronUp } from 'lucide-react'
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
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
  const first = s.first + s.history.length - lines.length
  // The newest line in view, as in a terminal, unless the user scrolled back to read.
  const list = useRef<HTMLOListElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const ol = list.current
    if (ol && pinned.current) ol.scrollTop = ol.scrollHeight
  }, [s.expanded, first, lines.length])
  useLayoutEffect(() => {
    pinned.current = true
  }, [s.expanded])
  return (
    <section className={s.expanded ? 'cmdline expanded' : 'cmdline'} aria-label="Command line">
      {lines.length > 0 && (
        <ol
          ref={list}
          className="cmdline-history"
          aria-live="polite"
          onScroll={(e) => {
            const ol = e.currentTarget
            pinned.current = ol.scrollTop + ol.clientHeight >= ol.scrollHeight - 2
          }}
        >
          {lines.map((line, i) => (
            // Each line keeps its number for good: a new line does not remount the others.
            <li key={first + i}>{line}</li>
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
