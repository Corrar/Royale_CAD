import { randomBytes } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

/** Larger files are refused before they are read: a string cannot hold them anyway. */
export const MAX_BYTES = 1 << 30

/**
 * Writes bytes to path so that a failure leaves the old file whole: a temporary file next to it, flushed to disk,
 * then renamed over it. The rename is atomic on the same volume.
 */
export async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    const fh = await open(tmp, 'wx')
    try {
      await fh.writeFile(bytes)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** A save dialog's answer, with .dxf added when the name has no extension. */
export const withDxf = (path: string): string => (extname(path) === '' ? `${path}.dxf` : path)

/** A suggested file name from the renderer, reduced to a plain name. */
export const safeName = (name: unknown): string => {
  const n = typeof name === 'string' ? basename(name).slice(0, 200).trim() : ''
  return n === '' ? 'Drawing1.dxf' : withDxf(n)
}

