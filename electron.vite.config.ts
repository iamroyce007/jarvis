import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'electron/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    // manifest, service worker and icons are copied verbatim: the service
    // worker must be served from the root scope to control the whole app.
    publicDir: resolve(__dirname, 'src/public'),
    resolve: { alias: { '@': resolve(__dirname, 'src') } },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          // The desktop window, and the phone. Two entry points, one component
          // library and one set of design tokens — the phone is a different
          // composition of the same system, not a different application.
          index: resolve(__dirname, 'src/index.html'),
          mobile: resolve(__dirname, 'src/mobile.html')
        }
      }
    }
  }
})
