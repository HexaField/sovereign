import dotenv from 'dotenv'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

dotenv.config({ path: '.env.local' })
dotenv.config()

import cors from 'cors'
import express from 'express'
import healthRouter from './routes/health'

const app = express()
const port = process.env.PORT || 3001
const host = process.env.HOST || 'localhost'

app.use(cors())
app.use(express.json())

app.use('/health', healthRouter)

const options = {
  key: fs.readFileSync(path.join(process.cwd(), '../../.certs/localhost.key')),
  cert: fs.readFileSync(path.join(process.cwd(), '../../.certs/localhost.cert'))
}

https.createServer(options, app).listen(Number(port), host, () => {
  console.log(`Server running at https://${host}:${port}`)
})
