import type { WorkerReply } from './dxf.worker'
import DxfWorker from './dxf.worker?worker'
import type { Parse } from './files'

/** Decodes and parses a DXF in a worker of its own, so the UI keeps drawing while a big file is read. */
export const parseInWorker: Parse = (bytes, progress) =>
  new Promise((resolve, reject) => {
    const worker = new DxfWorker()
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const r = e.data
      if (r.kind === 'progress') return progress(r.done)
      worker.terminate()
      if (r.kind === 'done') resolve(r.result)
      else reject(new Error(r.message))
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'the reader stopped'))
    }
    // The bytes are ours (from the main process): hand them over instead of copying them.
    worker.postMessage(bytes, [bytes.buffer])
  })
