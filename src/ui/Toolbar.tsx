import { useId, useSyncExternalStore, type KeyboardEvent } from 'react'
import type { Store } from '../app/stores'
import { TOOLBARS } from './tools'

/** Up and Down move along a toolbar, as the ARIA toolbar pattern has it; Tab goes through every button too. */
function arrows(e: KeyboardEvent<HTMLDivElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const buttons = [...e.currentTarget.querySelectorAll('button')]
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (at < 0) return
  e.preventDefault()
  buttons[(at + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]!.focus()
}

/**
 * Top left: the Draw, Modify and View toolbars. A button ends the command under way and starts its own, as a
 * toolbar does in AutoCAD; then typing goes on in the command line, so the button lets the focus go. The running
 * command's button shows pressed.
 */
export function Toolbar({ active, onRun }: { active: Store<string | null>; onRun: (inputs: readonly string[]) => void }) {
  const running = useSyncExternalStore(active.subscribe, active.get, active.get)
  const id = useId()
  return (
    <nav className="toolbars" aria-label="Tools">
      {TOOLBARS.map((bar, b) => (
        <div key={bar.name} className="toolbar" role="toolbar" aria-label={bar.name} aria-orientation="vertical" onKeyDown={arrows}>
          {bar.tools.map((t, i) => {
            const tip = `${id}tip${b}-${i}`
            return (
              <div key={t.label} className="toolbar-item">
                <button
                  type="button"
                  className="toolbar-button"
                  aria-label={t.label}
                  aria-describedby={tip}
                  aria-pressed={running !== null && running === t.inputs[0]}
                  onClick={(e) => {
                    onRun(t.inputs)
                    e.currentTarget.blur()
                  }}
                >
                  <t.icon size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <span id={tip} role="tooltip" className="toolbar-tip">
                  {t.label}
                  <kbd>{t.typed}</kbd>
                </span>
              </div>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
