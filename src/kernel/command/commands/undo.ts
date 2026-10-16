import { getNumber, type Command, type CommandContext, type CommandGen } from '../runtime'

const undoOnce = (ctx: CommandContext): boolean => {
  const label = ctx.doc.undo()
  ctx.message(label ?? 'Everything has been undone.')
  return label !== undefined
}

/** U: undoes the last command. */
export const u: Command = Object.assign(
  function* (ctx: CommandContext): CommandGen {
    undoOnce(ctx)
  },
  { noUndoGroup: true },
)

/** UNDO: undoes the given number of commands. */
export const undo: Command = Object.assign(
  function* (ctx: CommandContext): CommandGen {
    const n = yield* getNumber('Enter the number of operations to undo', { default: 1, positive: true })
    if (typeof n !== 'number') return
    for (let i = 0; i < Math.floor(n) && undoOnce(ctx); i++);
  },
  { noUndoGroup: true },
)

/** REDO: redoes what the last U or UNDO took back. */
export const redo: Command = Object.assign(
  function* (ctx: CommandContext): CommandGen {
    ctx.message(ctx.doc.redo() ?? 'Nothing to redo.')
  },
  { noUndoGroup: true },
)
