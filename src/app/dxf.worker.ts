import { packBuffers } from '../kernel/dxf/pack'
import { parseDxf } from '../kernel/dxf/reader'
import { decodeDxf } from './codec'
import { toResult, type ParseResult } from './files'

/** What the worker posts back: progress now and then, then the drawing or why there is none. */
export type WorkerReply = { kind: 'progress'; done: number } | { kind: 'done'; result: ParseResult } | { kind: 'error'; message: string }

// The renderer's lib is DOM, not WebWorker: the little of the worker scope used here, typed by hand.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Uint8Array>) => void) | null
  postMessage(reply: WorkerReply, transfer?: Transferable[]): void
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
    const result = toResult(parsed, e.data, encoding, warning)
    // The typed arrays and the file's bytes move to the page instead of being copied.
    scope.postMessage({ kind: 'done', result }, [...packBuffers(result.pack), result.meta.spans.buffer as ArrayBuffer, e.data.buffer as ArrayBuffer])
  } catch (error) {
    scope.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
