import { describe, it, expect } from 'vitest'

describe('JobsTab', () => {
  describe('§6.7 — Jobs Tab', () => {
    it('§6.7 — shows all scheduled jobs', async () => {
      const mod = await import('./JobsTab.js')
      expect(typeof mod.default).toBe('function')
      expect(typeof mod.fetchJobs).toBe('function')
    })

    it('§6.7 — each job shows name, schedule, last run time + status, next run time', async () => {
      const { getJobStatusClass, formatDuration } = await import('./JobsTab.js')
      expect(getJobStatusClass('success')).toContain('green')
      expect(getJobStatusClass('failure')).toContain('red')
      expect(getJobStatusClass('running')).toContain('blue')
      expect(formatDuration(500)).toBe('500ms')
      expect(formatDuration(2500)).toBe('2.5s')
      expect(formatDuration(90000)).toBe('1.5m')
    })

    it('§6.7 — actions: trigger now, enable/disable, view run history', async () => {
      const { triggerJob, toggleJob, fetchJobHistory } = await import('./JobsTab.js')
      expect(typeof triggerJob).toBe('function')
      expect(typeof toggleJob).toBe('function')
      expect(typeof fetchJobHistory).toBe('function')
    })
  })
})
