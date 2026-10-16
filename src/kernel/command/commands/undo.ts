import { getNumber, type Command, type CommandContext, type CommandGen } from '../runtime'

/** How many steps the last U or UNDO took back: what REDO brings back. */
const UNDONE = 'UNDONE'

const undoOnce = (ctx: CommandContext): boolean => {
  const label = ctx.doc.undo()
  ctx.message(label ?? 'Everything has been undone.')
  return label !== undefined
}

/** U: undoes the last command. */
export const u: Command = Object.assign(
  function* (ctx: CommandContext): CommandGen {
    ctx.vars.set(UNDONE, undoOnce(ctx) ? 1 : 0)
  },
  { noUndoGroup: true },
)

/** UNDO: undoes the given number of commands. */
export const undo: Command = Object.assign(
  function* (ctx: CommandContext): CommandGen {
    const n = yield* getNumber('Enter the number of operations to undo', { default: 1, positive: true, integer: true })
    if (typeof n !== 'number') return
    let done = 0
    while (done < n && undoOnce(ctx)) done++
    ctx.vars.set(UNDONE, done)
  },
  { noUndoGroup: true },
)

/** REDO: brings back all that the last U or UNDO took back; after that, one step at a time. */
export const redo: Command = Object.assign(
  function* (ctx: CommandContext): CommandGen {
    const n = Math.max(1, (ctx.vars.get(UNDONE) as number | undefined) ?? 1)
    ctx.vars.set(UNDONE, 1)
    for (let i = 0; i < n; i++) {
      const label = ctx.doc.redo()
      if (label === undefined) {
        if (i === 0) ctx.message('Nothing to redo.')
        return
      }
      ctx.message(label)
    }
  },
  { noUndoGroup: true },
)
