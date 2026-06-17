import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// All runtime deps (sharp, wallpaper, electron-store, menubar) are kept external
// so their native binaries / ESM entrypoints resolve from node_modules at runtime
// instead of being bundled. electron-builder ships + unpacks them (see electron-builder.yml).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
