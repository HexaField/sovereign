import { Router } from 'express'
import { exec as cpExec } from 'child_process'
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
