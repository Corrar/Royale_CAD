import type { Command, CommandContext, FileHost, Input, Request } from '../runtime'

/** The file host, or null with a message where there is none (the kernel tests, a bench). */
function hostOf(ctx: CommandContext): FileHost | null {
  if (ctx.host.files) return ctx.host.files
  ctx.message('Files are not available here.')
  return null
}

/** Whether to save unsaved changes first: true, false, or null to cancel. No question when nothing changed. */
function* saveFirst(ctx: CommandContext, files: FileHost): Generator<Request, boolean | null, Input> {
  if (!files.dirty()) return false
  const r = yield { kind: 'keyword', prompt: `Save changes to ${files.name()}?`, keywords: ['Yes', 'No', 'Cancel'], default: 'Yes' }
  if (r.kind !== 'keyword' || r.word === 'Cancel') return null
  return r.word === 'Yes'
}

const fileCommand = (f: Command): Command => Object.assign(f, { noUndoGroup: true })

/** OPEN: a drawing from a file, in place of this one. */
export const open = fileCommand(function* (ctx) {
  const files = hostOf(ctx)
  if (!files) return
  const save = yield* saveFirst(ctx, files)
  if (save !== null) files.open(save)
})

/** NEW: an empty drawing in place of this one. */
export const create = fileCommand(function* (ctx) {
  const files = hostOf(ctx)
  if (!files) return
  const save = yield* saveFirst(ctx, files)
  if (save !== null) files.create(save)
})

/** QSAVE (Ctrl+S): to the drawing's file, or to one asked for. */
export const qsave = fileCommand(function* (ctx) {
  hostOf(ctx)?.save()
})

/** SAVEAS: to a file asked for, which the drawing then goes by. */
export const saveas = fileCommand(function* (ctx) {
  hostOf(ctx)?.saveAs()
})
