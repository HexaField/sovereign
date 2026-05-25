import fs from 'node:fs'
import path from 'node:path'
import type { Device } from './types.js'

export interface DeviceStore {
  load(): Device[]
  save(devices: Device[]): void
}

export function createDeviceStore(dataDir: string): DeviceStore {
  const dir = path.join(dataDir, 'auth')
  const filePath = path.join(dir, 'devices.json')

  return {
    load(): Device[] {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8')
        return JSON.parse(raw) as Device[]
      } catch {
        return []
      }
    },
    save(devices: Device[]): void {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(devices, null, 2))
      fs.renameSync(tmp, filePath)
    }
  }
}
