import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Job, RunRecord } from './types.js'

export interface SchedulerStore {
  loadJobs(): Job[]
  saveJobs(jobs: Job[]): void
  appendRun(record: RunRecord): void
  readRuns(jobId: string, limit?: number): RunRecord[]
  deleteRunHistory(jobId: string): void
}

export function createStore(dataDir: string): SchedulerStore {
  const schedulerDir = path.join(dataDir, 'scheduler')
  const jobsFile = path.join(schedulerDir, 'jobs.json')
  const runsDir = path.join(schedulerDir, 'runs')

  const ensureDirs = () => {
    fs.mkdirSync(schedulerDir, { recursive: true })
    fs.mkdirSync(runsDir, { recursive: true })
  }

  const loadJobs = (): Job[] => {
    ensureDirs()
    if (!fs.existsSync(jobsFile)) return []
    const data = fs.readFileSync(jobsFile, 'utf-8')
    return JSON.parse(data) as Job[]
  }

  const saveJobs = (jobs: Job[]): void => {
    ensureDirs()
    const tmp = jobsFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2))
    fs.renameSync(tmp, jobsFile)
  }

  const appendRun = (record: RunRecord): void => {
    ensureDirs()
    const file = path.join(runsDir, `${record.jobId}.jsonl`)
    fs.appendFileSync(file, JSON.stringify(record) + '\n')
  }

  const readRuns = (jobId: string, limit?: number): RunRecord[] => {
    const file = path.join(runsDir, `${jobId}.jsonl`)
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    const records = lines.map((l) => JSON.parse(l) as RunRecord)
    if (limit) return records.slice(-limit)
    return records
  }

  const deleteRunHistory = (jobId: string): void => {
    const file = path.join(runsDir, `${jobId}.jsonl`)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }

  return { loadJobs, saveJobs, appendRun, readRuns, deleteRunHistory }
}
