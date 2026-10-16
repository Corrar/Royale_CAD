import { describe, expect, it } from 'vitest'
import { BUILTIN_COMMANDS } from './commands'
import { formatPrompt, getPoint, matchKeyword, type Command } from './runtime'
import { commandBench } from './testing'

describe('formatPrompt and matchKeyword', () => {
  it('formats like AutoCAD', () => {
    expect(formatPrompt(null)).toBe('Command:')
    expect(formatPrompt({ kind: 'point', prompt: 'Specify next point', keywords: ['Close', 'Undo'] })).toBe('Specify next point or [Close/Undo]:')
    expect(formatPrompt({ kind: 'number', prompt: 'Specify radius of circle', keywords: ['Diameter'], default: 5 })).toBe(
      'Specify radius of circle or [Diameter] <5.0000>:',
    )
  })

  it('matches exactly first, then by unique prefix, ignoring case', () => {
    const k = ['Close', 'Center', 'Undo', 'C']
    expect(matchKeyword('u', k)).toBe('Undo')
    expect(matchKeyword('CL', k)).toBe('Close')
    expect(matchKeyword('c', k)).toBe('C')
    expect(matchKeyword('ce', k)).toBe('Center')
    expect(matchKeyword('x', k)).toBeUndefined()
    expect(matchKeyword('c', ['Close', 'Center'])).toBeUndefined() // ambiguous
    // A keyword's capitals are its abbreviation, as AutoCAD writes them: M is Middle among MC and ML.
    expect(matchKeyword('m', ['Middle', 'ML', 'MC'])).toBe('Middle')
    expect(matchKeyword('mi', ['Middle', 'ML', 'MC'])).toBe('Middle')
  })
})

describe('createInterpreter', () => {
  it('an alias starts its command; Enter at the Command prompt repeats the last one', () => {
    const t = commandBench()
    expect(t.interp.prompt).toBe('Command:')
    t.run('l⏎')
    expect(t.interp.command).toBe('LINE')
    expect(t.interp.prompt).toBe('Specify first point:')
    t.run('0,0⏎1,0⏎⏎')
    expect(t.interp.command).toBeNull()
    t.run('⏎')
    expect(t.interp.command).toBe('LINE')
    t.run('line⏎')
    expect(t.interp.history).toContain('Command: LINE')
  })

  it('a drawing put in place with fewer layers leaves layer 0 current, not an index past its table', () => {
    const t = commandBench()
    t.doc.layers.add({ name: 'X', color: 1, visible: true, locked: false })
    t.doc.layers.add({ name: 'Y', color: 1, visible: true, locked: false })
    t.interp.layer = 2
    t.doc.replace([{ name: '0', color: 7, visible: true, locked: false }, { name: 'A', color: 2, visible: true, locked: false }], [])
    expect(t.interp.layer).toBe(0)
    t.run('-LAYER⏎⏎')
    expect(t.interp.history).not.toContainEqual(expect.stringMatching(/Error/))
  })

  it('aliases can be replaced while it runs (the settings): a new one works, a dropped one no longer does', () => {
    const t = commandBench()
    t.interp.aliases = { LL: 'LINE', Q: 'NOSUCH' }
    t.run('LL⏎')
    expect(t.interp.command).toBe('LINE')
    t.interp.cancel()
    t.run('L⏎')
    expect(t.interp.history.at(-1)).toBe('Unknown command "L".')
    // An alias of a command that does not exist is no command.
    t.run('Q⏎')
    expect(t.interp.history.at(-1)).toBe('Unknown command "Q".')
    expect(t.interp.aliases).toEqual({ LL: 'LINE', Q: 'NOSUCH' })
  })

  it('reports unknown commands and stays idle', () => {
    const t = commandBench()
    t.run('FOO⏎')
    t.run('3,4⏎')
    expect(t.interp.command).toBeNull()
    // What was typed stays in the history, as in AutoCAD.
    expect(t.interp.history.slice(-4)).toEqual(['Command: FOO', 'Unknown command "FOO".', 'Command: 3,4', 'Unknown command "3,4".'])
  })

  it('invalid input keeps the request', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎')
    const prompt = t.interp.prompt
    t.run('1,,2⏎')
    t.run('nope⏎')
    expect(t.interp.prompt).toBe(prompt)
    expect(t.interp.history.at(-1)).toBe('Point or option keyword required.')
    t.run('5,0⏎⏎')
    expect(t.lines()).toEqual([[0, 0, 5, 0]])
  })

  it('Esc ends the command with nothing pending; what it committed is one undo step', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎1,0⏎1,1⏎')
    t.interp.cancel()
    expect(t.interp.command).toBeNull()
    expect(t.interp.history.at(-1)).toBe('*Cancel*')
    expect(t.lines()).toHaveLength(2)
    expect(t.doc.undo()).toBe('LINE')
    expect(t.lines()).toEqual([])
    // The document takes new transactions: no group was left open.
    t.run('L⏎0,0⏎2,0⏎⏎')
    expect(t.doc.undo()).toBe('LINE')
  })

  it('@ is relative to the last point; a bare number is a distance towards the cursor', () => {
    const t = commandBench()
    t.run('L⏎2,3⏎@1,0⏎')
    t.interp.cursor = { x: 3, y: 10 }
    t.run('5⏎')
    t.interp.cursor = { x: 3, y: 8 } // on the base point: no direction
    t.run('2⏎')
    expect(t.interp.history.at(-1)).toBe('Move the cursor to give the direction.')
    t.run('@0,0⏎⏎')
    expect(t.lines()).toEqual([[2, 3, 3, 3], [3, 3, 3, 8], [3, 8, 3, 8]])
    expect(t.interp.lastPoint).toEqual({ x: 3, y: 8 })
  })

  it('a new drawing starts with LASTPOINT at 0,0 and no window begun', () => {
    const t = commandBench()
    t.run('L⏎500,500⏎600,600⏎⏎')
    t.click(-50, -50)
    t.doc.replace([{ name: '0', color: 7, visible: true, locked: false }], [])
    t.interp.newDrawing()
    expect(t.interp.lastPoint).toEqual({ x: 0, y: 0 })
    expect(t.interp.corner).toBeNull()
    t.run('L⏎@10,0⏎@0,10⏎⏎')
    expect(t.lines()).toEqual([[10, 0, 10, 10]])
  })

  it('a picked point answers a distance request with its distance from the base', () => {
    const t = commandBench()
    t.run('C⏎0,0⏎')
    t.click(3, 4)
    expect(t.circles()).toEqual([[0, 0, 5]])
  })

  it('a command that throws is reported and closes its undo group', () => {
    const boom: Command = function* (ctx) {
      ctx.doc.transact('BOOM', (tx) => void tx.add({ type: 'line', layer: 0, x0: 0, y0: 0, x1: 1, y1: 0 }))
      yield* getPoint('Specify a point')
      throw new Error('kaput')
    }
    const t = commandBench({ ...BUILTIN_COMMANDS, BOOM: boom })
    t.run('BOOM⏎1,1⏎')
    expect(t.interp.command).toBeNull()
    expect(t.interp.history.at(-1)).toBe('Error: kaput')
    expect(t.doc.undo()).toBe('BOOM')
  })

  it('echoes answered prompts into the history', () => {
    const t = commandBench()
    t.run('L⏎0,0⏎@3<90⏎⏎')
    expect(t.interp.history).toEqual(['Command: LINE', 'Specify first point: 0,0', 'Specify next point or [Undo]: @3<90', 'Specify next point or [Undo]:'])
  })

  it('notifies on every change', () => {
    const t = commandBench()
    let n = 0
    t.interp.onChange(() => n++)
    t.run('L⏎0,0⏎')
    t.click(1, 1)
    t.interp.cancel()
    expect(n).toBe(4)
  })
})
