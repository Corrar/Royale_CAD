import type { BBox } from '../kernel/geom/vec'
import { fit, panBy, zoomAt, type ViewState } from '../kernel/view'

export interface InputHost {
  getView(): ViewState
  setView(v: ViewState): void
  extents(): BBox | null
  /** Left button press at (sx, sy), CSS px relative to the target. */
  pick(sx: number, sy: number, shift: boolean): void
}

export const FIT_MARGIN_PX = 64

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
      return host.pick(e.clientX - r.left, e.clientY - r.top, e.shiftKey)
    }
    if (e.button !== 1) return
    target.setPointerCapture(e.pointerId)
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
  }
  const onMove = (e: PointerEvent): void => {
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
  return () => {
    target.removeEventListener('wheel', onWheel)
    target.removeEventListener('pointerdown', onDown)
    target.removeEventListener('pointermove', onMove)
    target.removeEventListener('pointerup', onEnd)
    target.removeEventListener('pointercancel', onEnd)
    target.removeEventListener('auxclick', onAux)
  }
}
