import { parseDxf } from '../kernel/dxf/reader'
import { decodeDxf } from './codec'
import type { ParseResult } from './files'

/** What the worker posts back: progress now and then, then the drawing or why there is none. */
export type WorkerReply = { kind: 'progress'; done: number } | { kind: 'done'; result: ParseResult } | { kind: 'error'; message: string }

// The renderer's lib is DOM, not WebWorker: the little of the worker scope used here, typed by hand.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Uint8Array>) => void) | null
  postMessage(reply: WorkerReply): void
}

scope.onmessage = (e) => {
  try {
    const { text, encoding, warning } = decodeDxf(e.data)
    let shown = -1
    const parsed = parseDxf(text, (done) => {
      const pct = Math.floor(done * 100)
      if (pct === shown) return
      shown = pct
      scope.postMessage({ kind: 'progress', done })
    })
    scope.postMessage({ kind: 'done', result: { parsed, encoding, warning } })
  } catch (error) {
    scope.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
