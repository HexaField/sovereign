import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [solid(), tailwindcss()],
    server: {
      host: env.HOST || 'localhost',
      port: parseInt(env.PORT || '3000'),
      https: {
        key: fs.readFileSync(path.resolve(process.cwd(), '../../.certs/localhost.key')),
        cert: fs.readFileSync(path.resolve(process.cwd(), '../../.certs/localhost.cert'))
      }
    }
  }
})
