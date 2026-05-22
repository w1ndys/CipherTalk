import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'
import { builtinModules } from 'module'

const pkg = require('./package.json')
const devServerPort = Number(process.env.VITE_PORT || process.env.PORT || 5321)
const external = [
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
  ...Object.keys(pkg.dependencies || {}),
]

export default defineConfig({
  base: './',
  optimizeDeps: {
    entries: ['index.html']
  },
  server: {
    port: devServerPort,
    strictPort: false  // 如果默认端口被占用，自动尝试下一个
  },
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external
            }
          }
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron'
          }
        }
      },
      {
        entry: 'electron/transcribeWorker.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: { external }
          }
        }
      },
      {
        entry: 'electron/wcdbWorker.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: { external }
          }
        }
      },
      {
        entry: 'electron/sessionQaWorker.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: { external }
          }
        }
      },
      {
        entry: 'electron/sessionVectorIndexWorker.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: { external }
          }
        }
      },
      {
        entry: 'electron/sessionMemoryBuildWorker.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: { external }
          }
        }
      },
      {
        entry: 'electron/agentToolWorker.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: { external }
          }
        }
      },
      {
        entry: 'electron/mcp.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: { external }
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  build: {
    rollupOptions: {
      external: [/^WeFlow\/.*/]
    }
  }
})
