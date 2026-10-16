import { describe, expect, it } from 'vitest'
import { DEFAULT_ALIASES } from '../kernel/command/aliases'
import { SNAP } from '../kernel/snap'
import { DEFAULT_SETTINGS, parseSettings, settingsText } from './settings'

const COMMANDS = new Set(['LINE', 'CIRCLE', 'COPY', 'MOVE'])

describe('settings', () => {
  it('without a file, the defaults: AutoCAD aliases and END MID CEN INT PER', () => {
    expect(parseSettings(null, COMMANDS)).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] })
    expect(DEFAULT_SETTINGS.aliases).toEqual(DEFAULT_ALIASES)
    expect(DEFAULT_SETTINGS.osnap).toBe(SNAP.END | SNAP.MID | SNAP.CEN | SNAP.INT | SNAP.PER)
  })

  it('reads back what it writes', () => {
    const s = { aliases: { LL: 'LINE', C: 'CIRCLE' }, osnap: SNAP.END | SNAP.NEA | SNAP.INS }
    const text = settingsText(s)
    expect(JSON.parse(text)).toEqual({ version: 1, osnap: ['END', 'NEA', 'INS'], aliases: { C: 'CIRCLE', LL: 'LINE' } })
    expect(parseSettings(text, COMMANDS)).toEqual({ settings: s, warnings: [] })
  })

  it('a file that is not JSON gives the defaults, with a warning', () => {
    const r = parseSettings('{ "osnap": [END] }', COMMANDS)
    expect(r.settings).toEqual(DEFAULT_SETTINGS)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/^settings\.json is not valid JSON \(.+\); the defaults are used\.$/)
    expect(parseSettings('[1, 2]', COMMANDS).warnings).toEqual(['settings.json does not hold an object; the defaults are used.'])
  })

  it('a bad part gives that part its default, a bad entry is left out; each said once', () => {
    const r = parseSettings(JSON.stringify({ osnap: 'END', aliases: { L: 'LINE', 'B A D': 'LINE', X: 'NOSUCH', CO: 7, m: 'move' } }), COMMANDS)
    expect(r.settings.osnap).toBe(DEFAULT_SETTINGS.osnap)
    // Upper case, as AutoCAD reads acad.pgp.
    expect(r.settings.aliases).toEqual({ L: 'LINE', M: 'MOVE' })
    expect(r.warnings).toEqual([
      'settings.json: "osnap" is not a list of snap modes; the default is used.',
      'settings.json: alias "B A D" is not a word; left out.',
      'settings.json: alias "X" names no command (NOSUCH); left out.',
      'settings.json: alias "CO" names no command (7); left out.',
    ])
    const modes = parseSettings(JSON.stringify({ osnap: ['end', 'TAN', 'INS'] }), COMMANDS)
    expect(modes.settings).toEqual({ aliases: DEFAULT_SETTINGS.aliases, osnap: SNAP.END | SNAP.INS })
    expect(modes.warnings).toEqual(['settings.json: snap mode "TAN" is not known; left out.'])
  })
})
