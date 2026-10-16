import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_SETTINGS_BYTES, readSettings, writeSettings } from './settings'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'royale-settings-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('settings file', () => {
  it('reads null when there is none, and what was written after, through new folders', async () => {
    const path = join(dir, 'new', 'settings.json')
    expect(await readSettings(path)).toBeNull()
    expect(await writeSettings(path, '{"osnap":[]}')).toBeNull()
    expect(await readSettings(path)).toBe('{"osnap":[]}')
    expect(await readdir(join(dir, 'new'))).toEqual(['settings.json'])
  })

  it('refuses what is not text or too big, and a file too big to read', async () => {
    const path = join(dir, 'settings.json')
    expect(await writeSettings(path, 42)).toEqual({ error: 'settings must be text' })
    expect(await writeSettings(path, 'x'.repeat(MAX_SETTINGS_BYTES + 1))).toEqual({ error: 'settings.json would be larger than 1 MB' })
    await writeFile(path, 'x'.repeat(MAX_SETTINGS_BYTES + 1))
    await expect(readSettings(path)).rejects.toThrow('settings.json is larger than 1 MB')
  })

  it('with no file to use (a smoke run), reads nothing and writes nowhere', async () => {
    expect(await readSettings(null)).toBeNull()
    expect(await writeSettings(null, '{}')).toBeNull()
    expect(await readdir(dir)).toEqual([])
    await expect(readFile(join(dir, 'settings.json'))).rejects.toThrow()
  })
})
