import { describe, expect, it } from 'vitest'
import type { FileHost } from '../runtime'
import { commandBench } from '../testing'

function fakeFiles(dirty: boolean) {
  const calls: string[] = []
  const files: FileHost = {
    name: () => 'Plant.dxf',
    dirty: () => dirty,
    busy: () => null,
    open: (save) => void calls.push(`open save=${save}`),
    create: (save) => void calls.push(`new save=${save}`),
    save: () => void calls.push('save'),
    saveAs: () => void calls.push('saveAs'),
  }
  return { files, calls }
}

describe('file commands', () => {
  it('OPEN and NEW go straight on when nothing changed', () => {
    const { files, calls } = fakeFiles(false)
    const t = commandBench(undefined, { files })
    t.run('OPEN⏎')
    t.run('NEW⏎')
    expect(calls).toEqual(['open save=false', 'new save=false'])
    expect(t.interp.command).toBeNull()
  })

  it('with unsaved changes they ask first: Enter saves, No discards, Cancel stays', () => {
    const { files, calls } = fakeFiles(true)
    const t = commandBench(undefined, { files })
    t.run('OPEN⏎')
    expect(t.interp.prompt).toBe('Save changes to Plant.dxf? [Yes/No/Cancel] <Yes>:')
    t.run('⏎')
    t.run('NEW⏎N⏎')
    t.run('OPEN⏎C⏎')
    expect(calls).toEqual(['open save=true', 'new save=false'])
  })

  it('QSAVE (and SAVE) saves, SAVEAS asks for a file; none of them is an undo step', () => {
    const { files, calls } = fakeFiles(true)
    const t = commandBench(undefined, { files })
    t.run('L⏎0,0⏎1,1⏎⏎')
    t.run('QSAVE⏎')
    t.run('SAVE⏎')
    t.run('SAVEAS⏎')
    expect(calls).toEqual(['save', 'save', 'saveAs'])
    expect(t.doc.undo()).toBe('LINE')
  })

  it('while a file operation is under way no command starts, typed or repeated by Enter', () => {
    const { files, calls } = fakeFiles(false)
    let busy: string | null = null
    const t = commandBench(undefined, { files: { ...files, busy: () => busy } })
    t.run('QSAVE⏎')
    busy = 'Saving Plant.dxf…'
    t.run('L⏎')
    t.run('⏎')
    t.run('XYZ⏎')
    expect(t.interp.command).toBeNull()
    expect(t.interp.history.slice(1)).toEqual([
      'Command: L', 'Wait: Saving Plant.dxf…',
      'Command:', 'Wait: Saving Plant.dxf…',
      'Command: XYZ', 'Unknown command "XYZ".',
    ])
    expect(calls).toEqual(['save'])
    busy = null
    t.run('L⏎')
    expect(t.interp.command).toBe('LINE')
  })

  it('without a file host they say so', () => {
    const t = commandBench()
    t.run('OPEN⏎')
    expect(t.interp.history.at(-1)).toBe('Files are not available here.')
  })

  it('print adds a line to the history from outside a command', () => {
    const t = commandBench()
    let n = 0
    t.interp.onChange(() => n++)
    t.interp.print('Saved Plant.dxf.')
    expect(t.interp.history.at(-1)).toBe('Saved Plant.dxf.')
    expect(n).toBe(1)
  })
})
