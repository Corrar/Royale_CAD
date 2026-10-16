import type { BBox } from '../kernel/geom/vec'
import { FIT_MARGIN_PX, fit, panBy, zoomAt, type ViewState } from '../kernel/view'

export interface InputHost {
  getView(): ViewState
  setView(v: ViewState): void
  extents(): BBox | null
  /** Left button press at (sx, sy), CSS px relative to the target. */
  click(sx: number, sy: number, shift: boolean): void
  /** Right button: Enter, as in AutoCAD. */
  enter(): void
  /** The cursor over the target, CSS px; null when it leaves. */
  hover(p: { x: number; y: number } | null): void
}

export const wheelFactor = (deltaY: number): number => Math.exp(-deltaY * 0.0015)

export function attachInput(target: HTMLElement, host: InputHost): () => void {
  let drag: { id: number; x: number; y: number } | null = null

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const r = target.getBoundingClientRect()
    host.setView(zoomAt(host.getView(), e.clientX - r.left, e.clientY - r.top, wheelFactor(e.deltaY)))
  }
  const onDown = (e: PointerEvent): void => {
    if (e.button === 0) {
      const r = target.getBoundingClientRect()
      return host.click(e.clientX - r.left, e.clientY - r.top, e.shiftKey)
    }
    if (e.button === 2) return host.enter()
    if (e.button !== 1) return
    target.setPointerCapture(e.pointerId)
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
  }
  const onMove = (e: PointerEvent): void => {
    const r = target.getBoundingClientRect()
    host.hover({ x: e.clientX - r.left, y: e.clientY - r.top })
    if (!drag) return
    if (!(e.buttons & 4)) return onEnd(e) // capture lost (e.g. alt-tab) without a pointerup
    host.setView(panBy(host.getView(), e.clientX - drag.x, e.clientY - drag.y))
    drag.x = e.clientX
    drag.y = e.clientY
  }
  const onEnd = (e: PointerEvent): void => {
    if (!drag) return
    target.releasePointerCapture(drag.id)
    drag = null
  }
  const onLeave = (): void => host.hover(null)
  const onMenu = (e: Event): void => e.preventDefault()
  const onAux = (e: MouseEvent): void => {
    if (e.button !== 1 || e.detail !== 2) return
    const box = host.extents()
    if (box) host.setView(fit(host.getView(), box, FIT_MARGIN_PX))
  }

  target.addEventListener('wheel', onWheel, { passive: false })
  target.addEventListener('pointerdown', onDown)
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onEnd)
  target.addEventListener('pointercancel', onEnd)
  target.addEventListener('auxclick', onAux)
  target.addEventListener('pointerleave', onLeave)
  target.addEventListener('contextmenu', onMenu)
  return () => {
    target.removeEventListener('pointerleave', onLeave)
    target.removeEventListener('contextmenu', onMenu)
    target.removeEventListener('wheel', onWheel)
    target.removeEventListener('pointerdown', onDown)
    target.removeEventListener('pointermove', onMove)
    target.removeEventListener('pointerup', onEnd)
    target.removeEventListener('pointercancel', onEnd)
    target.removeEventListener('auxclick', onAux)
  }
}

export interface KeyboardHost {
  /** The text typed and not yet submitted. */
  buffer(): string
  setBuffer(text: string): void
  /** Enter or Space. */
  submit(text: string): void
  /** Esc. */
  cancel(): void
  undo(): void
  redo(): void
  /** Del with nothing typed. */
  erase(): void
  /** F2. */
  toggleHistory(): void
  /** F3, F7 and F8. */
  toggle(setting: 'osnap' | 'grid' | 'ortho'): void
  /** Ctrl+O, Ctrl+S, Ctrl+Shift+S and Ctrl+N: OPEN, QSAVE, SAVEAS and NEW. */
  run(command: string): void
}

/** A field that takes typing itself: keys pressed there are not commands. */
function editable(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null
  return !!el && (el.isContentEditable === true || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
}

/**
 * Typing goes to the command line wherever the focus is, as in AutoCAD: Space and Enter submit, Esc cancels,
 * Backspace edits; Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) undo and redo; Ctrl+O, Ctrl+S, Ctrl+Shift+S and Ctrl+N open,
 * save, save as and begin a drawing; Del erases the selection; F2 shows the history;
 * F3, F7 and F8 toggle object snap, grid and ortho.
 */
export function attachKeyboard(target: EventTarget, host: KeyboardHost): () => void {
  const onKey = (ev: Event): void => {
    const e = ev as KeyboardEvent
    // AltGr (Ctrl+Alt on Windows) types characters such as @ on many layouts: those are text, not shortcuts.
    const altGr = e.getModifierState?.('AltGraph') === true
    if (editable(e.target) || (e.altKey && !altGr)) return
    const handled = ((): boolean => {
      if ((e.ctrlKey || e.metaKey) && !altGr) {
        const k = e.key.toLowerCase()
        if (k === 'z') e.shiftKey ? host.redo() : host.undo()
        else if (k === 'y') host.redo()
        else if (k === 'o') host.run('OPEN')
        else if (k === 's') host.run(e.shiftKey ? 'SAVEAS' : 'QSAVE')
        else if (k === 'n') host.run('NEW')
        else return false
        return true
      }
      switch (e.key) {
        case 'Enter':
        case ' ': {
          const text = host.buffer()
          host.setBuffer('')
          host.submit(text)
          return true
        }
        case 'Escape':
          host.setBuffer('')
          host.cancel()
          return true
        case 'Backspace':
          host.setBuffer(host.buffer().slice(0, -1))
          return true
        case 'Delete':
          if (host.buffer() === '') host.erase()
          return true
        case 'F2':
          host.toggleHistory()
          return true
        case 'F3':
          host.toggle('osnap')
          return true
        case 'F7':
          host.toggle('grid')
          return true
        case 'F8':
          host.toggle('ortho')
          return true
      }
      if (e.key.length !== 1) return false
      host.setBuffer(host.buffer() + e.key)
      return true
    })()
    if (handled) e.preventDefault()
  }
  target.addEventListener('keydown', onKey)
  return () => target.removeEventListener('keydown', onKey)
}
