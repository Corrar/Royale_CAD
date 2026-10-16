import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BUILTIN_COMMANDS } from '../kernel/command/commands'
import { DEFAULT_ALIASES } from '../kernel/command/aliases'
import { createStore } from '../app/stores'
import { aliasOf, TOOLBARS } from './tools'
import { Toolbar } from './Toolbar'

const tools = TOOLBARS.flatMap((b) => b.tools)

describe('tools', () => {
  it('each runs a command that exists, and its hint names the alias that types it', () => {
    for (const t of tools) {
      expect(BUILTIN_COMMANDS[t.inputs[0]!]).toBeDefined()
      const alias = aliasOf(t.inputs[0]!)
      if (alias) expect(t.hint).toContain(alias)
    }
    expect(aliasOf('LINE')).toBe('L')
    expect(aliasOf('COPY')).toBe('CO')
    expect(aliasOf('TEXT')).toBe('DT')
    expect(Object.entries(DEFAULT_ALIASES).filter(([, c]) => c === 'COPY').map(([a]) => a)).toContain(aliasOf('COPY'))
  })

  it('renders a labelled button for each, with its hint as a tooltip it is described by; the running one is pressed', () => {
    const html = renderToStaticMarkup(createElement(Toolbar, { active: createStore<string | null>('MOVE'), onRun: () => {} }))
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons).toHaveLength(tools.length)
    for (const b of buttons) {
      expect(b).toMatch(/aria-label="[^"]+"/)
      const tip = /aria-describedby="([^"]+)"/.exec(b)![1]!
      expect(html).toContain(`id="${tip}" role="tooltip"`)
    }
    expect(buttons.filter((b) => b.includes('aria-pressed="true"'))).toHaveLength(1)
    expect(buttons.find((b) => b.includes('aria-pressed="true"'))).toContain('aria-label="Move"')
    // Groups a screen reader can name.
    expect(html.match(/role="toolbar"/g)).toHaveLength(TOOLBARS.length)
  })
})
