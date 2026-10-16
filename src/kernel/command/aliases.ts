/**
 * Alias → command name, as in AutoCAD. Data, not code: the settings (T40) will let the user edit it. Names of
 * commands not implemented yet resolve to nothing and report as unknown.
 */
export const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
  L: 'LINE',
  C: 'CIRCLE',
  A: 'ARC',
  PL: 'PLINE',
  REC: 'RECTANG',
  E: 'ERASE',
  M: 'MOVE',
  CO: 'COPY',
  CP: 'COPY',
  RO: 'ROTATE',
  MI: 'MIRROR',
  SC: 'SCALE',
  O: 'OFFSET',
  TR: 'TRIM',
  EX: 'EXTEND',
  Z: 'ZOOM',
  P: 'PAN',
  LA: 'LAYER',
  DT: 'TEXT',
  DTEXT: 'TEXT',
  '-LA': '-LAYER',
  // AutoCAD's SAVE asks for a name on a drawing never saved and saves in place otherwise: QSAVE does both.
  SAVE: 'QSAVE',
}

/** The command a typed word starts: its own name first, then an alias; undefined when neither exists. */
export function resolveCommand(word: string, names: ReadonlySet<string>, aliases: Readonly<Record<string, string>>): string | undefined {
  const upper = word.toUpperCase()
  if (names.has(upper)) return upper
  const target = aliases[upper]
  return target !== undefined && names.has(target) ? target : undefined
}
