import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWrite, safeName, withDxf } from './atomic'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'royale-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('atomicWrite', () => {
  it('replaces the file and leaves nothing behind', async () => {
    const path = join(dir, 'a.dxf')
    await writeFile(path, 'old')
    await atomicWrite(path, new TextEncoder().encode('new'))
    expect(await readFile(path, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['a.dxf'])
  })

  // POSIX modes and symbolic links; Windows keeps neither the same way.
  it.skipIf(process.platform === 'win32')('keeps the mode of the file it replaces: a private drawing stays private', async () => {
    const path = join(dir, 'a.dxf')
    await writeFile(path, 'old')
    await chmod(path, 0o600)
    await atomicWrite(path, new TextEncoder().encode('new'))
    expect((await stat(path)).mode & 0o7777).toBe(0o600)
    await chmod(path, 0o640)
    await atomicWrite(path, new TextEncoder().encode('newer'))
    expect((await stat(path)).mode & 0o7777).toBe(0o640)
    // A new file gets the mode any new file gets.
    await writeFile(join(dir, 'plain'), '')
    await atomicWrite(join(dir, 'b.dxf'), new TextEncoder().encode('new'))
    expect((await stat(join(dir, 'b.dxf'))).mode).toBe((await stat(join(dir, 'plain'))).mode)
  })

  it.skipIf(process.platform === 'win32')('through a symbolic link writes the file it points to, and the link stays', async () => {
    await mkdir(join(dir, 'real'))
    const real = join(dir, 'real', 'a.dxf')
    await writeFile(real, 'old')
    const link = join(dir, 'link.dxf')
    await symlink(real, link)
    await atomicWrite(link, new TextEncoder().encode('new'))
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(real, 'utf8')).toBe('new')
    expect((await readdir(dir)).sort()).toEqual(['link.dxf', 'real'])
    expect(await readdir(join(dir, 'real'))).toEqual(['a.dxf'])
  })

  it('a failed write leaves the original whole and cleans up', async () => {
    const path = join(dir, 'a.dxf')
    await writeFile(path, 'old')
    // Renaming over a directory fails after the temporary file is written.
    const blocked = join(dir, 'b.dxf')
    await (await import('node:fs/promises')).mkdir(blocked)
    await expect(atomicWrite(blocked, new TextEncoder().encode('new'))).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('old')
    expect((await readdir(dir)).sort()).toEqual(['a.dxf', 'b.dxf'])
  })
})

describe('names', () => {
  it('a suggested name is reduced to a file name with .dxf', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd.dxf')
    expect(safeName('Plant.dxf')).toBe('Plant.dxf')
    expect(safeName(42)).toBe('Drawing1.dxf')
    expect(withDxf('/x/y')).toBe('/x/y.dxf')
    expect(withDxf('/x/y.DXF')).toBe('/x/y.DXF')
  })
})
