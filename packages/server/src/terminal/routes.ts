import { Router } from 'express'
import { exec as cpExec, spawn } from 'child_process'
import type { TerminalManager } from './terminal.js'

export function createTerminalRoutes(manager: TerminalManager): Router {
  const router = Router()

  // One-shot command execution (for recipes / quick scripts)
  router.post('/exec', (req, res) => {
    const { command, cwd } = req.body ?? {}
    if (!command || typeof command !== 'string') {
      res.status(400).json({ error: 'command is required' })
      return
    }
    const opts: { cwd?: string; timeout: number; maxBuffer: number } = {
      timeout: 30_000,
      maxBuffer: 1024 * 1024 // 1 MB
    }
    if (cwd && typeof cwd === 'string') opts.cwd = cwd
    cpExec(command, opts, (err, stdout, stderr) => {
      const exitCode = err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0
      res.json({
        stdout: stdout ?? '',
        stderr: stderr ?? (err ? err.message : ''),
        exitCode
      })
    })
  })

  // Streaming exec via SSE
  router.post('/exec/stream', (req, res) => {
    const { command, cwd } = req.body ?? {}
    if (!command || typeof command !== 'string') {
      res.status(400).json({ error: 'command is required' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const spawnOpts: { shell: boolean; cwd?: string } = { shell: true }
    if (cwd && typeof cwd === 'string') spawnOpts.cwd = cwd

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [], spawnOpts)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Spawn failed'
      res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`)
      res.end()
      return
    }

    let ended = false
    const sendEvent = (event: string, data: string) => {
      if (ended) return
      res.write(`event: ${event}\ndata: ${data}\n\n`)
    }
    const finish = () => {
      if (ended) return
      ended = true
      clearTimeout(timeout)
      res.end()
    }

    sendEvent('started', JSON.stringify({ pid: child.pid ?? -1 }))

    // Timeout: 5 minutes
    const timeout = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGTERM')
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already dead */
          }
        }, 5000)
      }
      sendEvent('error', JSON.stringify({ message: 'Process timed out after 300s' }))
      finish()
    }, 300_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      sendEvent('stdout', JSON.stringify(chunk.toString()))
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      sendEvent('stderr', JSON.stringify(chunk.toString()))
    })

    child.on('exit', (code) => {
      sendEvent('exit', JSON.stringify({ exitCode: code ?? 1 }))
      finish()
    })

    child.on('error', (err) => {
      sendEvent('error', JSON.stringify({ message: err.message }))
      finish()
    })

    // Client disconnect — kill child
    // Use res.on('close'), NOT req.on('close').
    // req 'close' fires when the request body is fully consumed (immediately
    // after JSON parsing), which would kill the child before it produces output.
    // res 'close' fires when the SSE response connection actually closes.
    res.on('close', () => {
      clearTimeout(timeout)
      if (!child.killed) {
        child.kill('SIGTERM')
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already dead */
          }
        }, 5000)
      }
    })
  })

  // Kill a running process by PID
  router.post('/exec/kill', (req, res) => {
    const { pid } = req.body ?? {}
    if (!pid || typeof pid !== 'number' || pid <= 0 || !Number.isInteger(pid)) {
      res.status(400).json({ error: 'pid must be a positive integer' })
      return
    }
    try {
      process.kill(pid, 'SIGTERM')
      setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already dead */
        }
      }, 5000)
      res.json({ ok: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to kill process'
      res.status(400).json({ error: msg })
    }
  })

  router.get('/sessions', (_req, res) => {
    res.json(manager.list())
  })

  router.get('/sessions/:id', (req, res) => {
    const session = manager.get(req.params.id)
    if (!session) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json(session)
  })

  router.delete('/sessions/:id', (req, res) => {
    const session = manager.get(req.params.id)
    if (!session) {
      res.status(404).json({ error: 'not found' })
      return
    }
    manager.close(req.params.id)
    res.json({ ok: true })
  })

  router.post('/sessions', (req, res) => {
    try {
      const { cwd, shell, cols, rows } = req.body ?? {}
      const session = manager.create({ cwd, shell, cols, rows })
      res.status(201).json(session)
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'failed' })
    }
  })

  return router
}
