import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// The dev server needs an inline script (React Refresh preamble) and a WebSocket (HMR).
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:*"

export default defineConfig({
  // A user-set rollupOptions replaces electron-vite's default externals, so electron is listed again.
  main: {
    build: {
      rollupOptions: { input: { main: resolve('electron/main.ts') }, external: ['electron'] },
    },
  },
  // Sandboxed preloads cannot be ESM.
  preload: {
    build: {
      rollupOptions: {
        input: { preload: resolve('electron/preload.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src',
    build: { rollupOptions: { input: { index: resolve('src/index.html') } } },
    plugins: [
      react(),
      {
        name: 'dev-csp',
        transformIndexHtml: {
          order: 'pre',
          handler: (html, ctx) =>
            ctx.server ? html.replace(/(http-equiv="Content-Security-Policy"\s+content=")[^"]*/, `$1${DEV_CSP}`) : html,
        },
      },
    ],
  },
})
