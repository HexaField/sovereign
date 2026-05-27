import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// Dev defaults — change here if you need to point the dev client at a remote
// Sovereign. Sovereign config (host/port/tls) lives in {dataDir}/config.json;
// the client is fronted by the server in production, so these values only
// matter when running `pnpm --filter @sovereign/client dev`.
const DEV_HOST = 'localhost'
const DEV_PORT = 3000
const API_TARGET = 'https://localhost:5801'

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    host: DEV_HOST,
    port: DEV_PORT,
    https: {
      key: fs.readFileSync(path.resolve(process.cwd(), '../../.certs/localhost.key')),
      cert: fs.readFileSync(path.resolve(process.cwd(), '../../.certs/localhost.cert'))
    },
    proxy: {
      '/ws': { target: API_TARGET, ws: true, secure: false },
      '/api': { target: API_TARGET, secure: false, changeOrigin: true },
      '/health': { target: API_TARGET, secure: false, changeOrigin: true }
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: []
  }
})
