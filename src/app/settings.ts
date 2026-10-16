import { DEFAULT_ALIASES } from '../kernel/command/aliases'
import { SNAP } from '../kernel/snap'

/** What the user can set, kept as settings.json in the app's userData. */
export interface Settings {
  /** Typed word to command name, as AutoCAD's acad.pgp. */
  aliases: Readonly<Record<string, string>>
  /** The object snap modes in use (OSMODE), as SNAP bits. */
  osnap: number
}

export const DEFAULT_SETTINGS: Settings = {
  aliases: DEFAULT_ALIASES,
  osnap: SNAP.END | SNAP.MID | SNAP.CEN | SNAP.INT | SNAP.PER,
}

/** The snap modes by their AutoCAD names, in the order the settings list them. */
export const SNAP_NAMES: readonly (keyof typeof SNAP)[] = ['END', 'MID', 'CEN', 'INT', 'QUA', 'PER', 'NEA', 'NOD', 'INS']

/** What the preload exposes as window.royaleSettings: settings.json, read and written whole. */
export interface SettingsApi {
  /** Its text; null when there is none yet. */
  read(): Promise<string | null>
  /** Replaces it; the error when it could not be written. */
  write(text: string): Promise<{ error: string } | null>
}

declare global {
  interface Window {
    /** Set by the preload in the app; absent in a plain browser. */
    royaleSettings?: SettingsApi
  }
}

const ALIAS = /^[A-Z0-9_-]+$/

/**
 * Settings from settings.json (null: no file, the defaults). Never fails: a file that is not JSON gives the
 * defaults, a bad part its default, a bad entry is left out, and each says why in a warning.
 */
export function parseSettings(text: string | null, commands: ReadonlySet<string>): { settings: Settings; warnings: string[] } {
  const warnings: string[] = []
  if (text === null) return { settings: DEFAULT_SETTINGS, warnings }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { settings: DEFAULT_SETTINGS, warnings: [`settings.json is not valid JSON (${why}); the defaults are used.`] }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { settings: DEFAULT_SETTINGS, warnings: ['settings.json does not hold an object; the defaults are used.'] }
  }
  const o = data as Record<string, unknown>

  let osnap = DEFAULT_SETTINGS.osnap
  if ('osnap' in o) {
    if (!Array.isArray(o.osnap)) warnings.push('settings.json: "osnap" is not a list of snap modes; the default is used.')
    else {
      osnap = 0
      for (const m of o.osnap) {
        const name = typeof m === 'string' ? m.toUpperCase() : null
        if (name !== null && (SNAP_NAMES as readonly string[]).includes(name)) osnap |= SNAP[name as keyof typeof SNAP]
        else warnings.push(`settings.json: snap mode ${JSON.stringify(m)} is not known; left out.`)
      }
    }
  }

  let aliases = DEFAULT_SETTINGS.aliases
  if ('aliases' in o) {
    if (typeof o.aliases !== 'object' || o.aliases === null || Array.isArray(o.aliases)) {
      warnings.push('settings.json: "aliases" is not a table of aliases; the defaults are used.')
    } else {
      const table: Record<string, string> = {}
      for (const [key, value] of Object.entries(o.aliases)) {
        const alias = key.trim().toUpperCase()
        const command = typeof value === 'string' ? value.trim().toUpperCase() : null
        if (!ALIAS.test(alias)) warnings.push(`settings.json: alias ${JSON.stringify(key)} is not a word; left out.`)
        else if (command === null || !commands.has(command)) warnings.push(`settings.json: alias "${alias}" names no command (${String(value)}); left out.`)
        else table[alias] = command
      }
      aliases = table
    }
  }
  return { settings: { aliases, osnap }, warnings }
}

/** settings.json for s: the modes by name, the aliases in alphabetical order. */
export function settingsText(s: Settings): string {
  const aliases = Object.fromEntries(Object.entries(s.aliases).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return `${JSON.stringify({ version: 1, osnap: SNAP_NAMES.filter((n) => (s.osnap & SNAP[n]) !== 0), aliases }, null, 2)}\n`
}
