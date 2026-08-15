// Device Monitor — collects system metrics from local + remote tailnet devices.
//
// Discovery-first: `tailscale status --json` provides the device registry.
// No manual config needed — all peers appear automatically. Optional
// `overrides` in config let the user set SSH aliases, custom labels,
// watched services, or exclude specific peers.
//
// Local metrics come from Node.js `os` module and /proc reads.
// Remote metrics come via SSH (single round-trip per device).
// Results are cached with a configurable TTL (default 30s).

import os from 'node:os'
import fs from 'node:fs'
import { execFile, execSync } from 'node:child_process'

// ── Types ──────────────────────────────────────────────────────────────

export interface DeviceMetrics {
  hostname: string
  os: string
  online: boolean
  tailscaleIP: string | null
  local: boolean

  cpu?: {
    cores: number
    usagePercent: number
    loadAvg: [number, number, number]
  }
  memory?: {
    totalBytes: number
    usedBytes: number
    availableBytes: number
  }
  gpu?: {
    name: string
    memoryTotalMB: number
    memoryUsedMB: number
    usagePercent: number
    tempC: number
  }
  storage?: Array<{
    mount: string
    totalBytes: number
    usedBytes: number
    filesystem: string
  }>
  network?: {
    interfaces: Array<{
      name: string
      rxBytes: number
      txBytes: number
    }>
  }
  processes?: Array<{
    pid: number
    name: string
    cpuPercent: number
    memPercent: number
  }>
  services?: Array<{
    name: string
    active: boolean
  }>
  temperature?: Array<{
    label: string
    tempC: number
  }>

  collectedAt: number
  error?: string
}

/** Optional per-device overrides, keyed by tailscale HostName. */
export interface DeviceOverride {
  /** Custom display label (default: tailscale HostName). */
  label?: string
  /** SSH config alias (default: tailscale HostName via MagicDNS). */
  sshHost?: string
  /** OS hint for parser selection (default: auto-detected from tailscale OS field). */
  osHint?: 'linux' | 'macos'
  /** Services to check (systemd unit names or launchd labels). */
  watchServices?: string[]
  /** Exclude this device from monitoring entirely. */
  exclude?: boolean
}

export interface DeviceMonitorConfig {
  /** Optional per-device overrides, keyed by tailscale HostName (case-insensitive match). */
  overrides?: Record<string, DeviceOverride>
  /** Cache TTL in milliseconds (default 30_000). */
  cacheTtlMs?: number
  /** SSH timeout in milliseconds (default 8_000). */
  sshTimeoutMs?: number
}

/** Internal device descriptor built from tailscale discovery + overrides. */
interface DiscoveredDevice {
  hostname: string
  label: string
  os: string
  osHint: 'linux' | 'macos'
  online: boolean
  tailscaleIP: string | null
  local: boolean
  sshHost: string
  watchServices: string[]
}

// OS values that SSH collection cannot handle.
const SKIP_OS = new Set(['android', 'iOS', 'windows'])

// ── Collection scripts ─────────────────────────────────────────────────

/** Single SSH command that outputs structured markers for each metric category. */
const LINUX_COLLECT_SCRIPT = `
echo "@@CPU@@"
cat /proc/loadavg 2>/dev/null
nproc 2>/dev/null
echo "@@MEM@@"
free -b 2>/dev/null | grep -E "^Mem:"
echo "@@DISK@@"
df -B1 --output=target,size,used,fstype / /home 2>/dev/null | tail -n +2
echo "@@GPU@@"
(nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null) || \
(rocm-smi --showmeminfo vram --showtemp --showuse --csv 2>/dev/null) || \
echo "none"
echo "@@PROCS@@"
ps -eo pid,pcpu,pmem,comm --sort=-pcpu --no-headers 2>/dev/null | head -10
echo "@@NET@@"
cat /proc/net/dev 2>/dev/null | grep -E "^\\s*(eth|wl|en|tailscale|wg)" | head -10
echo "@@TEMP@@"
for z in /sys/class/thermal/thermal_zone*/; do
  t=$(cat "$z/temp" 2>/dev/null) && ty=$(cat "$z/type" 2>/dev/null) && echo "$ty $t"
done 2>/dev/null
echo "@@SERVICES@@"
`.trim()

const MACOS_COLLECT_SCRIPT = `
echo "@@CPU@@"
sysctl -n vm.loadavg 2>/dev/null | tr -d '{}'
sysctl -n hw.ncpu 2>/dev/null
echo "@@MEM@@"
sysctl -n hw.memsize 2>/dev/null
vm_stat 2>/dev/null | grep -E "Pages (free|active|inactive|wired|speculative|occupied)" | head -6
echo "@@DISK@@"
df -b / /System/Volumes/Data 2>/dev/null | tail -n +2
echo "@@GPU@@"
echo "none"
echo "@@PROCS@@"
ps -eo pid,pcpu,pmem,comm -r 2>/dev/null | head -11 | tail -10
echo "@@NET@@"
netstat -ibn 2>/dev/null | grep -E "^en[0-9]" | head -5
echo "@@TEMP@@"
echo "none"
echo "@@SERVICES@@"
`.trim()

// ── Parsers ────────────────────────────────────────────────────────────

function parseSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>()
  const regex = /@@(\w+)@@\n([\s\S]*?)(?=@@\w+@@|$)/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(raw)) !== null) {
    sections.set(m[1], m[2].trim())
  }
  return sections
}

function parseLinuxMetrics(raw: string, watchServices: string[]): Partial<DeviceMetrics> {
  const s = parseSections(raw)
  const result: Partial<DeviceMetrics> = {}

  // CPU
  const cpuRaw = s.get('CPU') ?? ''
  const cpuLines = cpuRaw.split('\n').filter(Boolean)
  if (cpuLines.length >= 1) {
    const parts = cpuLines[0].split(/\s+/)
    const load1 = parseFloat(parts[0]) || 0
    const load5 = parseFloat(parts[1]) || 0
    const load15 = parseFloat(parts[2]) || 0
    const cores = parseInt(cpuLines[1] ?? '1') || 1
    result.cpu = {
      cores,
      usagePercent: Math.min(100, (load1 / cores) * 100),
      loadAvg: [load1, load5, load15]
    }
  }

  // Memory
  const memRaw = s.get('MEM') ?? ''
  if (memRaw) {
    // Mem:  total  used  free  shared  buff/cache  available
    const parts = memRaw.split(/\s+/)
    if (parts.length >= 7) {
      const total = parseInt(parts[1]) || 0
      const available = parseInt(parts[6]) || 0
      result.memory = {
        totalBytes: total,
        usedBytes: total - available,
        availableBytes: available
      }
    }
  }

  // Storage
  const diskRaw = s.get('DISK') ?? ''
  if (diskRaw) {
    const mounts: DeviceMetrics['storage'] = []
    for (const line of diskRaw.split('\n').filter(Boolean)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 4) {
        mounts.push({
          mount: parts[0],
          totalBytes: parseInt(parts[1]) || 0,
          usedBytes: parseInt(parts[2]) || 0,
          filesystem: parts[3]
        })
      }
    }
    // Deduplicate mounts (/ and /home may share a partition)
    const seen = new Set<string>()
    result.storage = mounts.filter((m) => {
      const key = `${m.totalBytes}:${m.filesystem}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  // GPU
  const gpuRaw = (s.get('GPU') ?? '').trim()
  if (gpuRaw && gpuRaw !== 'none') {
    // Try nvidia-smi format: name, memTotal(MiB), memUsed(MiB), util%, temp
    const parts = gpuRaw.split(',').map((p) => p.trim())
    if (parts.length >= 5) {
      result.gpu = {
        name: parts[0],
        memoryTotalMB: parseInt(parts[1]) || 0,
        memoryUsedMB: parseInt(parts[2]) || 0,
        usagePercent: parseInt(parts[3]) || 0,
        tempC: parseInt(parts[4]) || 0
      }
    }
    // rocm-smi output differs — try to parse it
    if (!result.gpu && gpuRaw.includes('VRAM')) {
      const vramMatch = gpuRaw.match(/(\d+)\s*\/\s*(\d+)/)
      const tempMatch = gpuRaw.match(/(\d+(?:\.\d+)?)\s*c/i)
      const useMatch = gpuRaw.match(/(\d+(?:\.\d+)?)\s*%/)
      if (vramMatch) {
        result.gpu = {
          name: 'AMD GPU',
          memoryUsedMB: parseInt(vramMatch[1]) || 0,
          memoryTotalMB: parseInt(vramMatch[2]) || 0,
          usagePercent: useMatch ? parseFloat(useMatch[1]) : 0,
          tempC: tempMatch ? parseFloat(tempMatch[1]) : 0
        }
      }
    }
  }

  // Processes
  const procsRaw = s.get('PROCS') ?? ''
  if (procsRaw) {
    result.processes = procsRaw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/)
        return {
          pid: parseInt(parts[0]) || 0,
          cpuPercent: parseFloat(parts[1]) || 0,
          memPercent: parseFloat(parts[2]) || 0,
          name: parts.slice(3).join(' ')
        }
      })
      .filter((p) => p.cpuPercent > 0 || p.memPercent > 0.5)
  }

  // Network
  const netRaw = s.get('NET') ?? ''
  if (netRaw) {
    const ifaces: Array<{ name: string; rxBytes: number; txBytes: number }> = []
    for (const line of netRaw.split('\n').filter(Boolean)) {
      const parts = line.trim().split(/[\s:]+/)
      if (parts.length >= 10) {
        ifaces.push({
          name: parts[0],
          rxBytes: parseInt(parts[1]) || 0,
          txBytes: parseInt(parts[9]) || 0
        })
      }
    }
    if (ifaces.length > 0) result.network = { interfaces: ifaces }
  }

  // Temperature
  const tempRaw = s.get('TEMP') ?? ''
  if (tempRaw && tempRaw !== 'none') {
    result.temperature = tempRaw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/)
        return {
          label: parts[0] ?? 'unknown',
          tempC: (parseInt(parts[1]) || 0) / 1000
        }
      })
      .filter((t) => t.tempC > 0 && t.tempC < 150)
  }

  // Services
  if (watchServices.length > 0) {
    const svcSection = s.get('SERVICES') ?? ''
    result.services = watchServices.map((name) => ({
      name,
      active: svcSection.includes(`${name}:active`) || svcSection.includes(`active (running)`)
    }))
  }

  return result
}

function parseMacosMetrics(raw: string, _watchServices: string[]): Partial<DeviceMetrics> {
  const s = parseSections(raw)
  const result: Partial<DeviceMetrics> = {}

  // CPU
  const cpuRaw = s.get('CPU') ?? ''
  const cpuLines = cpuRaw.split('\n').filter(Boolean)
  if (cpuLines.length >= 1) {
    const loadParts = cpuLines[0].trim().split(/\s+/)
    const load1 = parseFloat(loadParts[0]) || 0
    const load5 = parseFloat(loadParts[1]) || 0
    const load15 = parseFloat(loadParts[2]) || 0
    const cores = parseInt(cpuLines[1] ?? '1') || 1
    result.cpu = {
      cores,
      usagePercent: Math.min(100, (load1 / cores) * 100),
      loadAvg: [load1, load5, load15]
    }
  }

  // Memory — macOS vm_stat gives page counts
  const memRaw = s.get('MEM') ?? ''
  const memLines = memRaw.split('\n').filter(Boolean)
  if (memLines.length >= 2) {
    const totalBytes = parseInt(memLines[0]) || 0
    // Parse vm_stat pages (page size 16384 on Apple Silicon, 4096 on Intel)
    let freePages = 0
    let inactivePages = 0
    for (const line of memLines.slice(1)) {
      const val = parseInt((line.match(/:\s*(\d+)/) ?? [])[1] ?? '0')
      if (line.includes('free')) freePages += val
      if (line.includes('inactive')) inactivePages += val
      if (line.includes('speculative')) freePages += val
    }
    // Approximate page size from total / typical page count
    const pageSize = totalBytes > 16 * 1024 * 1024 * 1024 ? 16384 : 4096
    const available = (freePages + inactivePages) * pageSize
    result.memory = {
      totalBytes,
      usedBytes: totalBytes - available,
      availableBytes: available
    }
  }

  // Storage — macOS df -b: filesystem blocks used avail capacity mount
  const diskRaw = s.get('DISK') ?? ''
  if (diskRaw) {
    const mounts: DeviceMetrics['storage'] = []
    for (const line of diskRaw.split('\n').filter(Boolean)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 6) {
        const total = (parseInt(parts[1]) || 0) * 512
        const used = (parseInt(parts[2]) || 0) * 512
        mounts.push({
          mount: parts[parts.length - 1],
          totalBytes: total,
          usedBytes: used,
          filesystem: parts[0]
        })
      }
    }
    result.storage = mounts
  }

  // Processes
  const procsRaw = s.get('PROCS') ?? ''
  if (procsRaw) {
    result.processes = procsRaw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/)
        return {
          pid: parseInt(parts[0]) || 0,
          cpuPercent: parseFloat(parts[1]) || 0,
          memPercent: parseFloat(parts[2]) || 0,
          name: parts.slice(3).join(' ')
        }
      })
      .filter((p) => p.cpuPercent > 0 || p.memPercent > 0.5)
  }

  // Network — macOS netstat -ibn: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes
  const netRaw = s.get('NET') ?? ''
  if (netRaw) {
    const ifaces: Array<{ name: string; rxBytes: number; txBytes: number }> = []
    for (const line of netRaw.split('\n').filter(Boolean)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 10) {
        ifaces.push({
          name: parts[0],
          rxBytes: parseInt(parts[6]) || 0,
          txBytes: parseInt(parts[9]) || 0
        })
      }
    }
    if (ifaces.length > 0) result.network = { interfaces: ifaces }
  }

  return result
}

// ── Local collection ───────────────────────────────────────────────────

function collectLocal(label: string, watchServices: string[]): DeviceMetrics {
  const cpus = os.cpus()
  const loadAvg = os.loadavg() as [number, number, number]

  const result: DeviceMetrics = {
    hostname: label,
    os: `${os.type()} ${os.release()}`,
    online: true,
    tailscaleIP: null,
    local: true,
    cpu: {
      cores: cpus.length,
      usagePercent: Math.min(100, (loadAvg[0] / cpus.length) * 100),
      loadAvg
    },
    memory: {
      totalBytes: os.totalmem(),
      usedBytes: os.totalmem() - os.freemem(),
      availableBytes: os.freemem()
    },
    collectedAt: Date.now()
  }

  // Better memory reading from /proc/meminfo (available vs free)
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8')
    const totalMatch = meminfo.match(/MemTotal:\s+(\d+)/)
    const availMatch = meminfo.match(/MemAvailable:\s+(\d+)/)
    if (totalMatch && availMatch) {
      const totalKB = parseInt(totalMatch[1])
      const availKB = parseInt(availMatch[1])
      result.memory = {
        totalBytes: totalKB * 1024,
        usedBytes: (totalKB - availKB) * 1024,
        availableBytes: availKB * 1024
      }
    }
  } catch {
    // Fall back to os.freemem() (already set above)
  }

  // Storage
  try {
    const dfOut = execSync('df -B1 --output=target,size,used,fstype / /home 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 3000
    })
    const mounts: DeviceMetrics['storage'] = []
    const seen = new Set<string>()
    for (const line of dfOut.split('\n').slice(1).filter(Boolean)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 4) {
        const key = `${parts[1]}:${parts[3]}`
        if (seen.has(key)) continue
        seen.add(key)
        mounts.push({
          mount: parts[0],
          totalBytes: parseInt(parts[1]) || 0,
          usedBytes: parseInt(parts[2]) || 0,
          filesystem: parts[3]
        })
      }
    }
    result.storage = mounts
  } catch {
    /* skip */
  }

  // Temperature
  try {
    const thermalBase = '/sys/class/thermal/'
    if (fs.existsSync(thermalBase)) {
      const zones: Array<{ label: string; tempC: number }> = []
      for (const entry of fs.readdirSync(thermalBase).filter((d) => d.startsWith('thermal_zone'))) {
        try {
          const temp = parseInt(fs.readFileSync(`${thermalBase}${entry}/temp`, 'utf-8').trim())
          const type = fs.readFileSync(`${thermalBase}${entry}/type`, 'utf-8').trim()
          if (temp > 0 && temp < 150000) zones.push({ label: type, tempC: temp / 1000 })
        } catch {
          /* skip */
        }
      }
      if (zones.length > 0) result.temperature = zones
    }
  } catch {
    /* skip */
  }

  // GPU — try nvidia-smi first, then rocm-smi
  try {
    const gpuOut = execSync(
      'nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu ' +
        '--format=csv,noheader,nounits 2>/dev/null || echo ""',
      { encoding: 'utf-8', timeout: 3000 }
    ).trim()
    if (gpuOut) {
      const parts = gpuOut.split(',').map((p) => p.trim())
      if (parts.length >= 5) {
        result.gpu = {
          name: parts[0],
          memoryTotalMB: parseInt(parts[1]) || 0,
          memoryUsedMB: parseInt(parts[2]) || 0,
          usagePercent: parseInt(parts[3]) || 0,
          tempC: parseInt(parts[4]) || 0
        }
      }
    }
  } catch {
    /* no nvidia GPU */
  }

  // Top processes
  try {
    const psOut = execSync('ps -eo pid,pcpu,pmem,comm --sort=-pcpu --no-headers 2>/dev/null | head -10', {
      encoding: 'utf-8',
      timeout: 3000
    })
    result.processes = psOut
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/)
        return {
          pid: parseInt(parts[0]) || 0,
          cpuPercent: parseFloat(parts[1]) || 0,
          memPercent: parseFloat(parts[2]) || 0,
          name: parts.slice(3).join(' ')
        }
      })
      .filter((p) => p.cpuPercent > 0 || p.memPercent > 0.5)
  } catch {
    /* skip */
  }

  // Network interfaces
  try {
    const netDev = fs.readFileSync('/proc/net/dev', 'utf-8')
    const ifaces: Array<{ name: string; rxBytes: number; txBytes: number }> = []
    for (const line of netDev.split('\n')) {
      if (!/^\s*(eth|wl|en|tailscale|wg)/.test(line)) continue
      const parts = line.trim().split(/[\s:]+/)
      if (parts.length >= 10) {
        ifaces.push({
          name: parts[0],
          rxBytes: parseInt(parts[1]) || 0,
          txBytes: parseInt(parts[9]) || 0
        })
      }
    }
    if (ifaces.length > 0) result.network = { interfaces: ifaces }
  } catch {
    /* skip */
  }

  // Services
  if (watchServices.length > 0) {
    result.services = watchServices.map((name) => {
      try {
        const out = execSync(
          `systemctl --user is-active ${name} 2>/dev/null || systemctl is-active ${name} 2>/dev/null`,
          {
            encoding: 'utf-8',
            timeout: 2000
          }
        ).trim()
        return { name, active: out === 'active' }
      } catch {
        return { name, active: false }
      }
    })
  }

  return result
}

// ── Remote collection (SSH) ────────────────────────────────────────────

function collectRemote(device: DiscoveredDevice, timeoutMs: number): Promise<DeviceMetrics> {
  return new Promise((resolve) => {
    const script = device.osHint === 'macos' ? MACOS_COLLECT_SCRIPT : LINUX_COLLECT_SCRIPT

    // Add service checks to the script
    let fullScript = script
    if (device.watchServices.length > 0) {
      const svcChecks = device.watchServices
        .map((name) => {
          if (device.osHint === 'macos') {
            return `launchctl list 2>/dev/null | grep -q "${name}" && echo "${name}:active" || echo "${name}:inactive"`
          }
          return `(systemctl --user is-active ${name} 2>/dev/null || systemctl is-active ${name} 2>/dev/null) | head -1 | xargs -I{} echo "${name}:{}"`
        })
        .join('\n')
      fullScript += '\n' + svcChecks
    }

    const sshArgs = [
      device.sshHost,
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'BatchMode=yes',
      'bash',
      '-c',
      JSON.stringify(fullScript)
    ]

    const proc = execFile('ssh', sshArgs, { timeout: timeoutMs }, (err, stdout) => {
      const base: DeviceMetrics = {
        hostname: device.label,
        os: device.os,
        online: false,
        tailscaleIP: device.tailscaleIP,
        local: false,
        collectedAt: Date.now()
      }

      if (err) {
        base.error = err.message?.includes('timed out')
          ? 'SSH timeout'
          : err.message?.includes('Connection refused')
            ? 'SSH refused'
            : `SSH error: ${err.message?.slice(0, 80)}`
        resolve(base)
        return
      }

      base.online = true
      const parsed =
        device.osHint === 'macos'
          ? parseMacosMetrics(stdout, device.watchServices)
          : parseLinuxMetrics(stdout, device.watchServices)
      resolve({ ...base, ...parsed })
    })
    proc.stdin?.end()
  })
}

// ── Tailscale discovery ───────────────────────────────────────────────

interface TailscaleNode {
  HostName: string
  OS: string
  TailscaleIPs?: string[]
  Online?: boolean
  LastSeen?: string
}

function mapOsHint(tsOs: string): 'linux' | 'macos' {
  return tsOs.toLowerCase() === 'macos' ? 'macos' : 'linux'
}

async function discoverFromTailscale(overrides: Record<string, DeviceOverride>): Promise<DiscoveredDevice[]> {
  const raw: string = await new Promise((resolve, reject) => {
    const proc = execFile('tailscale', ['status', '--json'], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
    proc.stdin?.end()
  })
  const data = JSON.parse(raw)
  const devices: DiscoveredDevice[] = []
  const localHostname = os.hostname().toLowerCase()

  // Helper: build a DiscoveredDevice from a tailscale node
  const addNode = (node: TailscaleNode, online: boolean) => {
    const hostname = node.HostName
    const hostLower = hostname.toLowerCase()

    // Match override by case-insensitive hostname
    const override =
      overrides[hostname] ??
      overrides[hostLower] ??
      Object.entries(overrides).find(([k]) => k.toLowerCase() === hostLower)?.[1]

    // Skip excluded devices
    if (override?.exclude) return

    // Skip devices where SSH collection cannot work
    if (SKIP_OS.has(node.OS)) return

    const isLocal = hostLower === localHostname
    const ip = node.TailscaleIPs?.[0] ?? null

    devices.push({
      hostname,
      label: override?.label ?? hostname,
      os: node.OS,
      osHint: override?.osHint ?? mapOsHint(node.OS),
      online,
      tailscaleIP: ip,
      local: isLocal,
      sshHost: override?.sshHost ?? hostname,
      watchServices: override?.watchServices ?? []
    })
  }

  // Self
  const self: TailscaleNode | undefined = data.Self
  if (self) addNode(self, true)

  // Peers
  for (const peer of Object.values(data.Peer ?? {}) as TailscaleNode[]) {
    addNode(peer, peer.Online ?? false)
  }

  return devices
}

// ── Monitor ────────────────────────────────────────────────────────────

export function createDeviceMonitor(config?: DeviceMonitorConfig) {
  const cacheTtl = config?.cacheTtlMs ?? 30_000
  const sshTimeout = config?.sshTimeoutMs ?? 8_000
  const overrides = config?.overrides ?? {}
  let cache: { devices: DeviceMetrics[]; collectedAt: number } | null = null
  let inflight: Promise<DeviceMetrics[]> | null = null

  async function collect(): Promise<DeviceMetrics[]> {
    let discovered: DiscoveredDevice[]
    try {
      discovered = await discoverFromTailscale(overrides)
    } catch {
      // Tailscale unavailable — fall back to local-only
      console.warn('[device-monitor] tailscale unavailable — collecting local metrics only')
      const hostname = os.hostname()
      const override = overrides[hostname] ?? overrides[hostname.toLowerCase()]
      return [collectLocal(override?.label ?? hostname, override?.watchServices ?? ['sovereign'])]
    }

    // Collect local devices directly, remote devices via SSH (in parallel)
    const results = await Promise.all(
      discovered.map((d) => {
        if (d.local) {
          const metrics = collectLocal(d.label, d.watchServices)
          metrics.tailscaleIP = d.tailscaleIP
          return Promise.resolve(metrics)
        }
        if (!d.online) {
          // Offline peer — return skeleton without attempting SSH
          return Promise.resolve<DeviceMetrics>({
            hostname: d.label,
            os: d.os,
            online: false,
            tailscaleIP: d.tailscaleIP,
            local: false,
            collectedAt: Date.now()
          })
        }
        return collectRemote(d, sshTimeout)
      })
    )

    return results
  }

  /** Get cached or fresh device metrics. Deduplicates concurrent requests. */
  async function getMetrics(): Promise<DeviceMetrics[]> {
    if (cache && Date.now() - cache.collectedAt < cacheTtl) {
      return cache.devices
    }

    // Deduplicate concurrent collections
    if (inflight) return inflight

    inflight = collect()
      .then((devices) => {
        cache = { devices, collectedAt: Date.now() }
        inflight = null
        return devices
      })
      .catch((err) => {
        inflight = null
        console.warn('[device-monitor] collection error:', err)
        return cache?.devices ?? []
      })

    return inflight
  }

  /** Force a fresh collection, bypassing cache. */
  async function refresh(): Promise<DeviceMetrics[]> {
    cache = null
    return getMetrics()
  }

  return { getMetrics, refresh }
}

export type DeviceMonitor = ReturnType<typeof createDeviceMonitor>
