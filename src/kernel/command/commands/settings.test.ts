import { describe, expect, it } from 'vitest'
import { createDocument } from '../../document'
import { createSelection } from '../../selection'
import { createInterpreter, runScript } from '../runtime'
import { BUILTIN_COMMANDS } from '.'

describe('OSNAP, DSETTINGS and ALIASEDIT', () => {
  it('show the settings at their tab, by name or alias, with nothing to undo', () => {
    const shown: string[] = []
    const doc = createDocument()
    const interp = createInterpreter(doc, createSelection(), { commands: BUILTIN_COMMANDS, host: { showSettings: (tab) => void shown.push(tab) } })
    runScript(interp, 'OS⏎DS⏎SE⏎OSNAP⏎DSETTINGS⏎ALIASEDIT⏎')
    expect(shown).toEqual(['osnap', 'osnap', 'osnap', 'osnap', 'osnap', 'aliases'])
    expect(interp.command).toBeNull()
    expect(doc.undo()).toBeUndefined()
  })

  it('say so where the app shows no settings', () => {
    const interp = createInterpreter(createDocument(), createSelection(), { commands: BUILTIN_COMMANDS })
    runScript(interp, 'OS⏎')
    expect(interp.history.at(-1)).toBe('No settings to show here.')
  })
})
