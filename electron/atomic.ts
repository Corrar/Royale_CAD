import { randomBytes } from 'node:crypto'
import { open, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

/** Larger files are refused before they are read: a string cannot hold them anyway. */
export const MAX_BYTES = 1 << 30

/**
 * Writes bytes to path so that a failure leaves the old file whole: a temporary file next to it, flushed to disk,
 * then renamed over it. The rename is atomic on the same volume. The file replaced keeps its mode and, where
 * allowed, its owner; through a symbolic link, the file it points to is the one replaced, and the link stays.
 */
export async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const target = await realpath(path).catch(() => path)
  const old = await stat(target).catch(() => null)
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    // Readable by its owner alone until it has the old file's mode: a private drawing is never open to others.
    const fh = await open(tmp, 'wx', old ? 0o600 : 0o666)
    try {
      await fh.writeFile(bytes)
      await fh.sync()
      if (old) {
        // Another owner's file keeps its owner where we may give it (root, or the same owner); otherwise ours.
        if (process.platform !== 'win32') await fh.chown(old.uid, old.gid).catch(() => {})
        await fh.chmod(old.mode & 0o7777)
      }
    } finally {
      await fh.close()
    }
    await rename(tmp, target)
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

