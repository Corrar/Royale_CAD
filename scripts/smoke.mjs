import { spawnSync } from 'node:child_process'

// pnpm forwards the literal "--" in `pnpm smoke -- --shot=x`; Electron would treat what follows as positional args.
const args = process.argv.slice(2).filter((a) => a !== '--')
const run = (cmd, a) => spawnSync(cmd, a, { stdio: 'inherit', shell: true }).status ?? 1
const built = run('electron-vite', ['build'])
process.exit(built !== 0 ? built : run('electron', ['.', '--smoke', ...args.map((a) => JSON.stringify(a))]))
