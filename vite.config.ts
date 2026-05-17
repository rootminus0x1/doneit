import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readdirSync, statSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

// Serves the local DoneIt/ directory at /local-data/ with directory listing.
// Only registered when running vite --mode localdata.
function serveLocalData(): Plugin {
  return {
    name: 'serve-local-data',
    configureServer(server) {
      server.middlewares.use('/local-data', (req, res, next) => {
        const urlPath = decodeURIComponent((req.url ?? '/').replace(/\?.*$/, '')).replace(/^\/+/, '')
        const fsPath = join(process.cwd(), 'DoneIt', urlPath)

        if (!existsSync(fsPath)) {
          res.statusCode = 404
          res.end('Not found')
          return
        }

        try {
          const s = statSync(fsPath)
          if (s.isDirectory()) {
            const entries = readdirSync(fsPath).map(name => ({
              name,
              type: statSync(join(fsPath, name)).isDirectory() ? 'directory' : 'file',
            }))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(entries))
          } else {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            res.end(readFileSync(fsPath))
          }
        } catch (e) {
          next(e)
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => ({
  base: '/doneit/',
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    mode === 'localdata' && serveLocalData(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Done It',
        short_name: 'Done It',
        description: 'Personal hiking track viewer',
        theme_color: '#1a73e8',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/doneit/',
        icons: [
          { src: '/doneit/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/doneit/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
}))
