import { defineConfig } from 'tsdown'

/** Bundle only the desktop main process; Electron and the updater remain packaged runtime dependencies. */
export default defineConfig({
  entry: ['lib/types/main/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { entryFileNames: 'index.js' },
  deps: { neverBundle: ['electron', 'electron-updater'] },
})
