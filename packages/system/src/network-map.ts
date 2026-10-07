// Network map — a live picture of the tailnet and LAN: every device, what
// hardware it has, which services listen on it, and which talk to which.
//
// One script per device (local bash, or SSH like the device monitor) reads the
// listening and established TCP sockets, the process behind each (systemd unit,
// Docker container, command line), addresses, the default gateway, LAN
// neighbours and hardware. Links come from established connections matched to
// the listener they reach, plus the Tailscale path (direct or relay) and
// throughput from this machine's view.

import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { findOverride, SKIP_OS, type DeviceMetrics, type DeviceMonitor, type DeviceOverride } from './device-monitor.js'

// ── Types ──────────────────────────────────────────────────────────────

/** How far a listener reaches: this machine only, the tailnet, or every network. */
export type Exposure = 'loopback' | 'tailnet' | 'network'

export interface NetService {
  id: string
  name: string
  /** Listening TCP ports. Empty for a process that only connects out. */
  ports: number[]
  exposure?: Exposure
  /** systemd unit or Docker container that runs it. */
  unit?: string
}

export interface NetHardware {
  cpu?: string
  cores?: number
  memoryBytes?: number
  gpus: string[]
  disks: Array<{ name: string; bytes: number; model?: string }>
  peripherals: string[]
}

export type NetDeviceKind = 'host' | 'phone' | 'lan' | 'gateway' | 'internet'

export interface NetDevice {
  id: string
  label: string
  kind: NetDeviceKind
  os?: string
  online: boolean
  /** The machine Sovereign runs on. */
  hub?: boolean
  tailscaleIP?: string
  lanIPs: string[]
  mac?: string
  hardware?: NetHardware
  usage?: { cpuPercent?: number; memoryPercent?: number; gpuPercent?: number }
  /** Bytes per second over the physical interfaces since the last scan. */
  traffic?: { rxBps: number; txBps: number }
  services: NetService[]
  error?: string
}

export type NetLinkKind = 'tcp' | 'tailnet' | 'lan' | 'wan' | 'proxy'

export interface NetLink {
  id: string
  /** Device or service id. */
  from: string
  to: string
  kind: NetLinkKind
  /** Open TCP connections behind a tcp link. */
  connections?: number
  /** Tailnet path: "LAN", "direct" or "relay <region>". */
  path?: string
  active?: boolean
  /** Tailnet bytes per second, both directions, since the last scan. */
  rateBps?: number
}

export interface NetworkMap {
  collectedAt: number
  devices: NetDevice[]
  links: NetLink[]
}

// ── Scan scripts ───────────────────────────────────────────────────────

const LINUX_SCRIPT = `
L=$(ss -Htlnp 2>/dev/null); E=$(ss -Htnp state established 2>/dev/null)
echo @@LISTEN@@; echo "$L"
echo @@ESTAB@@; echo "$E"
echo @@PROCS@@
for pid in $(printf '%s\\n%s\\n' "$L" "$E" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
  u=$(sed -n 's#.*/##p' /proc/$pid/cgroup 2>/dev/null | head -1)
  a=$(tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null | cut -c1-200)
  printf '%s\\t%s\\t%s\\n' "$pid" "$u" "$a"
done
echo @@ADDR@@; ip -o addr show 2>/dev/null | awk '{print $2, $4}'
echo @@ROUTE@@; ip route show default 2>/dev/null | head -1
echo @@NEIGH@@; ip neigh show 2>/dev/null
echo @@DOCKER@@; docker ps --format '{{.Names}}\\t{{.Ports}}' 2>/dev/null
echo @@SERVE@@; tailscale serve status --json 2>/dev/null
echo @@NETDEV@@; cat /proc/net/dev 2>/dev/null
echo @@CPU@@; grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2-; nproc 2>/dev/null
echo @@MEM@@; awk '/MemTotal/{print $2 * 1024}' /proc/meminfo 2>/dev/null
echo @@GPU@@; lspci 2>/dev/null | grep -Ei 'vga|3d controller|display' | cut -d: -f3-
echo @@AUDIO@@; sed -n 's/^ *[0-9]* \\[.*\\]: [^ ]* - //p' /proc/asound/cards 2>/dev/null
echo @@VIDEO@@; cat /sys/class/video4linux/*/name 2>/dev/null | sort -u
echo @@DISK@@; lsblk -dbno NAME,SIZE,TYPE,MODEL 2>/dev/null | awk '$3=="disk"'
`.trim()

const MACOS_SCRIPT = `
L=$(lsof +c 0 -nP -iTCP -sTCP:LISTEN -F pcn 2>/dev/null); E=$(lsof +c 0 -nP -iTCP -sTCP:ESTABLISHED -F pcn 2>/dev/null)
echo @@LSOF_LISTEN@@; echo "$L"
echo @@LSOF_ESTAB@@; echo "$E"
echo @@PROCS@@
P=$(printf '%s\\n%s\\n' "$L" "$E" | sed -n 's/^p//p' | sort -u | paste -sd, -)
[ -n "$P" ] && ps -o pid=,args= -p "$P" 2>/dev/null | sed -E 's/^ *([0-9]+) /\\1\\t\\t/' | cut -c1-200
echo @@ADDR@@; ifconfig 2>/dev/null | awk '/^[a-z]/{sub(":","",$1); i=$1} /inet6? /{print i, $2}'
echo @@ROUTE@@; route -n get default 2>/dev/null | awk '/gateway/{g=$2} /interface/{i=$2} END{if(g) print "default via", g, "dev", i}'
echo @@ARP@@; arp -an 2>/dev/null
echo @@DOCKER@@; docker ps --format '{{.Names}}\\t{{.Ports}}' 2>/dev/null
echo @@NETSTAT@@; netstat -ibn 2>/dev/null
echo @@CPU@@; sysctl -n machdep.cpu.brand_string hw.ncpu 2>/dev/null
echo @@MEM@@; sysctl -n hw.memsize 2>/dev/null
`.trim()

// ── Parsing ────────────────────────────────────────────────────────────

export interface Sock {
  ip: string
  port: number
  pid?: number
  comm?: string
}

export interface Conn {
  local: Sock
  peer: { ip: string; port: number }
}

export interface HostScan {
  listen: Sock[]
  estab: Conn[]
  procs: Map<number, { unit?: string; args?: string }>
  addrs: Array<{ iface: string; ip: string; prefix?: number }>
  gateway?: { ip: string; iface?: string }
  neigh: Array<{ ip: string; mac: string; iface: string }>
  docker: Array<{ name: string; ports: number[] }>
  /** Tailscale Serve: tailnet port → local port it proxies to. */
  serve: Array<{ port: number; target?: number }>
  hardware: NetHardware
  /** Byte counters summed over the physical interfaces. */
  netdev?: { rx: number; tx: number }
}

function sections(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of raw.split('\n')) {
    const m = /^@@([A-Z_]+)@@$/.exec(line.trim())
    if (m) {
      current = []
      out.set(m[1], current)
    } else if (current && line.trim()) current.push(line)
  }
  return out
}

/** `127.0.0.1:80`, `[::1]:80`, `*:80`, `127.0.0.53%lo:53` → ip + port. Wildcards become 0.0.0.0. */
export function splitHostPort(s: string): { ip: string; port: number } | null {
  const i = s.lastIndexOf(':')
  if (i < 0) return null
  const rawPort = s.slice(i + 1)
  // A listener's peer column reads `0.0.0.0:*`.
  const port = rawPort === '*' ? 0 : Number(rawPort)
  if (!Number.isInteger(port)) return null
  let ip = s.slice(0, i)
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  ip = ip.replace(/%.*$/, '')
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  if (ip === '*' || ip === '::') ip = '0.0.0.0'
  return { ip, port }
}

/** Lines of `ss -Htnp` (listening or established): the last two addresses, then the process. */
export function parseSs(lines: string[]): Array<{ local: Sock; peer: { ip: string; port: number } }> {
  const out: Array<{ local: Sock; peer: { ip: string; port: number } }> = []
  for (const line of lines) {
    const [head, users] = line.split(/\s+users:/)
    const tokens = head.trim().split(/\s+/)
    if (tokens.length < 2) continue
    const local = splitHostPort(tokens[tokens.length - 2])
    const peer = splitHostPort(tokens[tokens.length - 1])
    if (!local || !peer) continue
    const proc = users ? /\(\("(.+?)",pid=(\d+)/.exec(users) : null
    out.push({ local: { ...local, ...(proc ? { comm: proc[1], pid: Number(proc[2]) } : {}) }, peer })
  }
  return out
}

/** `lsof -F pcn` records: listeners have a plain address, connections `a->b`. */
export function parseLsof(lines: string[]): Array<{ local: Sock; peer?: { ip: string; port: number } }> {
  const out: Array<{ local: Sock; peer?: { ip: string; port: number } }> = []
  let pid: number | undefined
  let comm: string | undefined
  for (const line of lines) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      pid = Number(value)
      comm = undefined
    } else if (tag === 'c') comm = value
    else if (tag === 'n') {
      const [a, b] = value.split('->')
      const local = splitHostPort(a)
      if (!local) continue
      const peer = b ? splitHostPort(b) : null
      out.push({ local: { ...local, pid, comm }, ...(peer ? { peer } : {}) })
    }
  }
  return out
}

/** Collapse a CIDR string into ip + prefix. */
function cidr(s: string): { ip: string; prefix?: number } {
  const [ip, p] = s.split('/')
  return { ip: ip.replace(/%.*$/, ''), ...(p ? { prefix: Number(p) } : {}) }
}

/** The bracketed product name lspci gives, or the whole line. */
function gpuName(line: string): string {
  const s = line.replace(/\(rev [0-9a-f]+\)/i, '').trim()
  const brackets = [...s.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1])
  const product = brackets[brackets.length - 1]
  // AMD lists every variant of the chip (`Radeon 8050S / 8060S Graphics`): keep the last.
  return product && !/^AMD\/ATI$/.test(product) ? product.split(' / ').pop()! : s
}

export function parseScan(raw: string, macos: boolean): HostScan {
  const s = sections(raw)
  const get = (k: string) => s.get(k) ?? []
  const scan: HostScan = {
    listen: [],
    estab: [],
    procs: new Map(),
    addrs: [],
    neigh: [],
    docker: [],
    serve: [],
    hardware: { gpus: [], disks: [], peripherals: [] }
  }

  if (macos) {
    scan.listen = parseLsof(get('LSOF_LISTEN')).map((r) => r.local)
    scan.estab = parseLsof(get('LSOF_ESTAB')).flatMap((r) => (r.peer ? [{ local: r.local, peer: r.peer }] : []))
  } else {
    scan.listen = parseSs(get('LISTEN')).map((r) => r.local)
    scan.estab = parseSs(get('ESTAB'))
  }

  for (const line of get('PROCS')) {
    const [pid, unit, ...args] = line.split('\t')
    if (!/^\d+$/.test(pid)) continue
    scan.procs.set(Number(pid), { unit: unit || undefined, args: args.join('\t').trim() || undefined })
  }

  for (const line of get('ADDR')) {
    const [iface, addr] = line.trim().split(/\s+/)
    if (iface && addr) scan.addrs.push({ iface, ...cidr(addr) })
  }

  const route = /via (\S+)(?:.* dev (\S+))?/.exec(get('ROUTE')[0] ?? '')
  if (route) scan.gateway = { ip: route[1], ...(route[2] ? { iface: route[2] } : {}) }

  for (const line of get('NEIGH')) {
    const m = /^(\d+\.\d+\.\d+\.\d+) dev (\S+) lladdr ([0-9a-f:]+) (?!FAILED|INCOMPLETE)/.exec(line)
    if (m) scan.neigh.push({ ip: m[1], iface: m[2], mac: m[3] })
  }
  for (const line of get('ARP')) {
    const m = /\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+) on (\S+)/.exec(line)
    if (m) scan.neigh.push({ ip: m[1], mac: m[2], iface: m[3] })
  }

  for (const line of get('DOCKER')) {
    const [name, ports = ''] = line.split('\t')
    const published = [...new Set([...ports.matchAll(/:(\d+)->/g)].map((m) => Number(m[1])))]
    if (name) scan.docker.push({ name, ports: published })
  }

  try {
    const serve = JSON.parse(get('SERVE').join('\n') || '{}')
    for (const [hostPort, cfg] of Object.entries<any>(serve.Web ?? {})) {
      const port = Number(hostPort.split(':').pop())
      const proxy = Object.values<any>(cfg?.Handlers ?? {}).find((h) => h?.Proxy)?.Proxy as string | undefined
      const target = proxy ? /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(proxy)?.[1] : undefined
      if (Number.isInteger(port)) scan.serve.push({ port, ...(target ? { target: Number(target) } : {}) })
    }
    for (const [port, cfg] of Object.entries<any>(serve.TCP ?? {})) {
      if (scan.serve.some((e) => e.port === Number(port))) continue
      const target = /:(\d+)$/.exec(cfg?.TCPForward ?? '')?.[1]
      scan.serve.push({ port: Number(port), ...(target ? { target: Number(target) } : {}) })
    }
  } catch {
    // No serve config.
  }

  const physical = /^(en|eth|wl)/
  let rx = 0
  let tx = 0
  let counted = false
  for (const line of get('NETDEV')) {
    const [name, rest] = line.split(':')
    if (!rest || !physical.test(name.trim())) continue
    const f = rest.trim().split(/\s+/).map(Number)
    rx += f[0] || 0
    tx += f[8] || 0
    counted = true
  }
  for (const line of get('NETSTAT')) {
    const f = line.trim().split(/\s+/)
    if (!physical.test(f[0]) || !f[2]?.startsWith('<Link#')) continue
    rx += Number(f[f.length - 5]) || 0
    tx += Number(f[f.length - 2]) || 0
    counted = true
  }
  if (counted) scan.netdev = { rx, tx }

  const hw = scan.hardware
  const cpu = get('CPU').map((l) => l.trim())
  if (cpu[0]) hw.cpu = cpu[0]
  if (cpu[1] && /^\d+$/.test(cpu[1])) hw.cores = Number(cpu[1])
  const mem = Number(get('MEM')[0])
  if (mem > 0) hw.memoryBytes = mem
  hw.gpus = get('GPU').map(gpuName)
  // A webcam often names itself twice: `1080P Webcam: 1080P Webcam`.
  hw.peripherals = [
    ...new Set([...get('AUDIO'), ...get('VIDEO')].map((l) => l.trim().replace(/^(.+): \1$/, '$1')).filter(Boolean))
  ]
  for (const line of get('DISK')) {
    const [name, size, , ...model] = line.trim().split(/\s+/)
    const bytes = Number(size)
    if (bytes >= 1e9 && !/^(zram|loop|ram)/.test(name))
      hw.disks.push({ name, bytes, model: model.join(' ') || undefined })
  }
  return scan
}

// ── Naming ─────────────────────────────────────────────────────────────

const WELL_KNOWN_PORTS: Record<number, string> = {
  22: 'SSH',
  53: 'DNS',
  80: 'HTTP',
  443: 'HTTPS',
  631: 'CUPS printing',
  3389: 'RDP',
  5353: 'mDNS',
  11434: 'Ollama'
}

const KNOWN_APPS: Array<[RegExp, string]> = [
  [/\.vscode-server|Code Helper|Visual Studio Code/i, 'VS Code'],
  [/\bollama\b/i, 'Ollama'],
  [/tailscaled/i, 'Tailscale'],
  [/\bsshd\b/, 'SSH'],
  [/Google Chrome|\bchrome\b/i, 'Chrome'],
  [/firefox/i, 'Firefox'],
  [/(^|\/)claude( |$)/, 'Claude Code']
]

const RUNTIMES = /^(node|nodejs|python[\d.]*|deno|bun|ruby|java)$/

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

/** A systemd service unit names its process; scopes, slices and the user manager do not. */
function unitName(unit?: string): string | undefined {
  const m = unit ? /^(.+)\.service$/.exec(unit) : null
  return m && !/^user@\d+$/.test(m[1]) ? m[1] : undefined
}

/** A name for a process from its command line. */
function processName(args: string | undefined, comm: string | undefined): string | undefined {
  const text = `${args ?? ''} ${comm ?? ''}`
  for (const [re, name] of KNOWN_APPS) if (re.test(text)) return name
  if (!args) return comm
  const parts = args.split(' ')
  const exe = basename(parts[0])
  if (RUNTIMES.test(exe)) {
    const script = parts.slice(1).find((p) => /\.(m?js|ts|py)$/.test(p))
    if (script) {
      const file = basename(script).replace(/\.\w+$/, '')
      // `dist/index.js` says little; the package directory says more.
      if (/^(index|main|server|cli)$/.test(file)) {
        const dirs = script.split('/').filter((d) => d && !/^(dist|src|bin|build|lib|\.\.?)$/.test(d))
        return dirs.length > 1 ? dirs[dirs.length - 2] : file
      }
      return file
    }
  }
  return exe || comm
}

function exposureOf(ip: string, tailnetIPs: Set<string>): Exposure {
  if (ip.startsWith('127.') || ip === '::1') return 'loopback'
  if (tailnetIPs.has(ip)) return 'tailnet'
  return 'network'
}

const EXPOSURE_RANK: Record<Exposure, number> = { loopback: 0, tailnet: 1, network: 2 }

// ── IP helpers ─────────────────────────────────────────────────────────

const isLoopback = (ip: string) => ip.startsWith('127.') || ip === '::1'
const isV4 = (ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0
}

function sameSubnet(a: string, b: string, prefix: number): boolean {
  if (!isV4(a) || !isV4(b)) return false
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (v4ToInt(a) & mask) === (v4ToInt(b) & mask)
}

/** Private, CGNAT, link-local and unique-local ranges: never "the internet". */
function isPrivate(ip: string): boolean {
  if (isV4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      a === 0
    )
  }
  return /^(fc|fd|fe80|::1$)/i.test(ip)
}

/** A MAC with the locally-administered bit set: a phone or laptop hiding its real address. */
function isRandomMac(mac: string): boolean {
  return (parseInt(mac.slice(0, 2), 16) & 0x02) !== 0
}

// ── Build ──────────────────────────────────────────────────────────────

/** One device as Tailscale (or the local fallback) knows it. */
export interface NetTarget {
  id: string
  label: string
  os: string
  online: boolean
  hub: boolean
  /** SSH (or local bash) can scan it. */
  scannable: boolean
  sshHost: string
  tailscaleIPs: string[]
  tailnet?: { curAddr: string; relay: string; active: boolean; bytes: number }
}

export interface BuildInput {
  targets: Array<{ target: NetTarget; scan?: HostScan; error?: string }>
  /** Device-monitor metrics, matched by label, for usage and memory/storage totals. */
  metrics?: DeviceMetrics[]
  /** Labels for LAN-only devices, keyed by IP. */
  lanLabels?: Record<string, string>
  traffic?: Record<string, { rxBps: number; txBps: number }>
  tailnetRates?: Record<string, number>
  now?: number
}

interface Listener {
  serviceId: string
  sock: Sock
}

export function buildNetworkMap(input: BuildInput): NetworkMap {
  const devices: NetDevice[] = []
  const linkMap = new Map<string, NetLink>()
  const byId = new Map<string, NetDevice>()
  // Every IP a device answers on → device id.
  const ipOwner = new Map<string, string>()
  const listeners = new Map<string, Listener[]>()
  // device id → pid → service id
  const pidService = new Map<string, Map<number, string>>()
  const scanned = new Set<string>()

  const addLink = (from: string, to: string, kind: NetLinkKind, extra: Partial<NetLink> = {}) => {
    if (from === to) return
    const id = `${kind}:${from}->${to}`
    const existing = linkMap.get(id)
    if (existing) {
      if (kind === 'tcp') existing.connections = (existing.connections ?? 0) + 1
      return
    }
    linkMap.set(id, { id, from, to, kind, ...(kind === 'tcp' ? { connections: 1 } : {}), ...extra })
  }

  const metricsFor = (label: string) => input.metrics?.find((m) => m.hostname === label)

  // ── Devices and their services ──
  for (const { target, scan, error } of input.targets) {
    const phone = /^(android|ios)$/i.test(target.os)
    const dev: NetDevice = {
      id: target.id,
      label: target.label,
      kind: phone ? 'phone' : 'host',
      os: target.os,
      online: target.online,
      ...(target.hub ? { hub: true } : {}),
      ...(target.tailscaleIPs[0] ? { tailscaleIP: target.tailscaleIPs[0] } : {}),
      lanIPs: [],
      services: [],
      ...(error ? { error } : {})
    }
    for (const ip of target.tailscaleIPs) ipOwner.set(ip, dev.id)
    devices.push(dev)
    byId.set(dev.id, dev)

    const m = metricsFor(target.label)
    if (m?.online) {
      dev.usage = {
        ...(m.cpu ? { cpuPercent: m.cpu.usagePercent } : {}),
        ...(m.memory?.totalBytes ? { memoryPercent: (m.memory.usedBytes / m.memory.totalBytes) * 100 } : {}),
        ...(m.gpu ? { gpuPercent: m.gpu.usagePercent } : {})
      }
    }
    if (input.traffic?.[dev.id]) dev.traffic = input.traffic[dev.id]
    if (!scan) continue
    scanned.add(dev.id)

    // Hardware: the scan, topped up by the device monitor.
    const hw: NetHardware = { ...scan.hardware, gpus: [...scan.hardware.gpus], disks: [...scan.hardware.disks] }
    if (!hw.memoryBytes && m?.memory?.totalBytes) hw.memoryBytes = m.memory.totalBytes
    if (!hw.cores && m?.cpu?.cores) hw.cores = m.cpu.cores
    if (m?.gpu?.name && m.gpu.memoryTotalMB > 0) {
      // nvidia-smi names the card and its memory better than lspci.
      const vendor = /nvidia|geforce|rtx|gtx/i
      hw.gpus = [
        `${m.gpu.name} · ${Math.round(m.gpu.memoryTotalMB / 1024)} GB`,
        ...hw.gpus.filter((g) => !vendor.test(g) || !vendor.test(m.gpu!.name))
      ]
    }
    if (!hw.disks.length && m?.storage?.length) {
      // macOS mounts one APFS container several times; one entry per size is enough.
      for (const s of m.storage) {
        if (!hw.disks.some((k) => k.bytes === s.totalBytes)) hw.disks.push({ name: s.mount, bytes: s.totalBytes })
      }
    }
    if (hw.cpu || hw.gpus.length || hw.memoryBytes) dev.hardware = hw

    for (const a of scan.addrs) {
      ipOwner.set(a.ip, dev.id)
      if (isV4(a.ip) && !isLoopback(a.ip) && scan.gateway?.iface === a.iface) dev.lanIPs.push(a.ip)
    }

    const tailnetIPs = new Set(target.tailscaleIPs)
    const services = new Map<string, NetService>()
    const pids = new Map<number, string>()
    const devListeners: Listener[] = []
    const dockerPort = new Map<number, string>()
    for (const c of scan.docker) for (const p of c.ports) dockerPort.set(p, c.name)
    const servePorts = new Set(scan.serve.map((e) => e.port))

    const service = (name: string, unit?: string): NetService => {
      let svc = services.get(name)
      if (!svc) {
        svc = { id: `${dev.id}/${name}`, name, ports: [], ...(unit ? { unit } : {}) }
        services.set(name, svc)
      }
      return svc
    }
    const nameFor = (sock: Sock, listening: boolean): { name: string; unit?: string } | undefined => {
      if (listening && dockerPort.has(sock.port)) {
        const name = dockerPort.get(sock.port)!
        return { name, unit: `docker:${name}` }
      }
      const proc = sock.pid !== undefined ? scan.procs.get(sock.pid) : undefined
      const unit = unitName(proc?.unit)
      if (unit) return { name: unit, unit: proc!.unit }
      if (sock.pid !== undefined || sock.comm) {
        const name = processName(proc?.args, sock.comm)
        if (name) return { name }
      }
      if (!listening) return undefined
      // tailscaled binds its peer API and Serve to the tailnet address.
      if (tailnetIPs.has(sock.ip)) return { name: servePorts.has(sock.port) ? 'Tailscale Serve' : 'Tailscale' }
      return { name: WELL_KNOWN_PORTS[sock.port] ?? `port ${sock.port}` }
    }

    for (const sock of scan.listen) {
      const n = nameFor(sock, true)!
      const svc = service(n.name, n.unit)
      if (!svc.ports.includes(sock.port)) svc.ports.push(sock.port)
      const exp = exposureOf(sock.ip, tailnetIPs)
      if (!svc.exposure || EXPOSURE_RANK[exp] > EXPOSURE_RANK[svc.exposure]) svc.exposure = exp
      if (sock.pid !== undefined) pids.set(sock.pid, svc.id)
      devListeners.push({ serviceId: svc.id, sock })
    }
    for (const svc of services.values()) svc.ports.sort((a, b) => a - b)
    dev.services = [...services.values()]
    listeners.set(dev.id, devListeners)
    pidService.set(dev.id, pids)
  }

  // ── LAN: gateway and neighbours (seen from any scanned host) ──
  const hubTarget = input.targets.find((t) => t.target.hub && t.scan) ?? input.targets.find((t) => t.scan)
  const gw = hubTarget?.scan?.gateway
  let gatewayId: string | undefined
  let lanPrefix = 24
  if (gw && isV4(gw.ip)) {
    const hubAddr = hubTarget!.scan!.addrs.find((a) => a.iface === gw.iface && isV4(a.ip))
    lanPrefix = hubAddr?.prefix ?? 24
    gatewayId = `gw:${gw.ip}`
    const gateway: NetDevice = {
      id: gatewayId,
      label: input.lanLabels?.[gw.ip] ?? `Router ${gw.ip}`,
      kind: 'gateway',
      online: true,
      lanIPs: [gw.ip],
      services: []
    }
    devices.push(gateway)
    byId.set(gatewayId, gateway)
    ipOwner.set(gw.ip, gatewayId)
    const internet: NetDevice = {
      id: 'internet',
      label: 'Internet',
      kind: 'internet',
      online: true,
      lanIPs: [],
      services: []
    }
    devices.push(internet)
    byId.set('internet', internet)
    addLink(gatewayId, 'internet', 'wan')
  }
  const onLan = (ip: string) => !!gw && sameSubnet(ip, gw.ip, lanPrefix)

  // A tailnet peer reached directly over the LAN sits on the LAN too.
  for (const { target } of input.targets) {
    const cur = target.tailnet?.curAddr ? splitHostPort(target.tailnet.curAddr)?.ip : undefined
    const dev = byId.get(target.id)!
    if (cur && onLan(cur) && !dev.lanIPs.includes(cur)) {
      dev.lanIPs.push(cur)
      ipOwner.set(cur, dev.id)
    }
  }

  for (const { scan } of input.targets) {
    for (const n of scan?.neigh ?? []) {
      if (!onLan(n.ip) || ipOwner.has(n.ip)) continue
      const id = `lan:${n.ip}`
      const dev: NetDevice = {
        id,
        label: input.lanLabels?.[n.ip] ?? (isRandomMac(n.mac) ? `Wi-Fi device ${n.ip}` : `LAN device ${n.ip}`),
        kind: 'lan',
        online: true,
        lanIPs: [n.ip],
        mac: n.mac,
        services: []
      }
      devices.push(dev)
      byId.set(id, dev)
      ipOwner.set(n.ip, id)
    }
  }
  if (gatewayId) {
    for (const dev of devices) if (dev.id !== gatewayId && dev.lanIPs.some(onLan)) addLink(gatewayId, dev.id, 'lan')
  }

  // ── Tailnet paths from the hub ──
  const hub = input.targets.find((t) => t.target.hub)?.target
  if (hub) {
    for (const { target } of input.targets) {
      if (target.hub || !target.online || !target.tailnet) continue
      const t = target.tailnet
      const cur = t.curAddr ? splitHostPort(t.curAddr)?.ip : undefined
      const path = cur ? (onLan(cur) ? 'LAN' : 'direct') : t.relay ? `relay ${t.relay}` : undefined
      const rate = input.tailnetRates?.[target.id]
      addLink(hub.id, target.id, 'tailnet', {
        active: t.active,
        ...(path ? { path } : {}),
        ...(rate !== undefined ? { rateBps: rate } : {})
      })
    }
  }

  // ── Connections ──
  const listenerAt = (deviceId: string, ip: string, port: number): Listener | undefined => {
    const list = listeners.get(deviceId) ?? []
    return (
      list.find((l) => l.sock.port === port && l.sock.ip === ip) ??
      list.find((l) => l.sock.port === port && l.sock.ip === '0.0.0.0') ??
      (isLoopback(ip) ? list.find((l) => l.sock.port === port && isLoopback(l.sock.ip)) : undefined)
    )
  }
  const deviceOf = (ip: string, self: string): string | undefined => {
    if (isLoopback(ip)) return self
    const owner = ipOwner.get(ip)
    if (owner) return owner
    return isPrivate(ip) ? undefined : byId.has('internet') ? 'internet' : undefined
  }

  for (const { target, scan } of input.targets) {
    if (!scan) continue
    const self = target.id
    const pids = pidService.get(self)!
    const dev = byId.get(self)!

    const clientId = (sock: Sock): string | undefined => {
      if (sock.pid !== undefined && pids.has(sock.pid)) return pids.get(sock.pid)
      const proc = sock.pid !== undefined ? scan.procs.get(sock.pid) : undefined
      const name =
        unitName(proc?.unit) ?? (sock.pid !== undefined || sock.comm ? processName(proc?.args, sock.comm) : undefined)
      if (!name) return undefined
      let svc = dev.services.find((s) => s.name === name)
      if (!svc) {
        svc = {
          id: `${self}/${name}`,
          name,
          ports: [],
          ...(proc?.unit && unitName(proc.unit) ? { unit: proc.unit } : {})
        }
        dev.services.push(svc)
      }
      if (sock.pid !== undefined) pids.set(sock.pid, svc.id)
      return svc.id
    }

    for (const c of scan.estab) {
      const peerDev = deviceOf(c.peer.ip, self)
      if (!peerDev) continue
      const served = listenerAt(self, c.local.ip, c.local.port)
      if (served) {
        // Server side: record only clients nobody else reports — the same
        // machine and scanned peers report their own client sockets.
        if (peerDev === self || scanned.has(peerDev)) continue
        addLink(peerDev, served.serviceId, 'tcp')
        continue
      }
      const from = clientId(c.local) ?? (peerDev === self ? undefined : self)
      if (!from) continue
      const to = scanned.has(peerDev) ? (listenerAt(peerDev, c.peer.ip, c.peer.port)?.serviceId ?? peerDev) : peerDev
      // A socket into this machine that reaches no listener we can see says nothing.
      if (to !== self) addLink(from, to, 'tcp')
    }

    for (const e of scan.serve) {
      if (e.target === undefined) continue
      const front = dev.services.find((s) => s.name === 'Tailscale Serve')
      const back = listenerAt(self, '127.0.0.1', e.target)
      if (front && back) addLink(front.id, back.serviceId, 'proxy')
    }
  }

  // Unnamed client processes that reach nothing stay out of the picture.
  const linked = new Set<string>()
  for (const l of linkMap.values()) {
    linked.add(l.from)
    linked.add(l.to)
  }
  for (const dev of devices) dev.services = dev.services.filter((s) => s.ports.length > 0 || linked.has(s.id))

  return { collectedAt: input.now ?? Date.now(), devices, links: [...linkMap.values()] }
}

// ── Monitor ────────────────────────────────────────────────────────────

export interface NetworkMonitorOptions {
  overrides?: Record<string, DeviceOverride>
  /** Usage figures and memory/storage totals come from here when given. */
  deviceMonitor?: DeviceMonitor
  /** Serve a scan this long before running another (ms). */
  cacheTtlMs?: number
  /** Give up on a device after this long (ms). */
  timeoutMs?: number
  /** Run a script on a device and return its stdout. Tests swap this. */
  runScript?: (target: NetTarget, script: string, timeoutMs: number) => Promise<string>
  /** Raw `tailscale status --json`. Tests swap this. */
  tailscaleStatus?: () => Promise<any>
}

function defaultRunScript(target: NetTarget, script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = target.hub
      ? spawn('bash', ['-s'], { stdio: ['pipe', 'pipe', 'ignore'] })
      : spawn(
          'ssh',
          [
            target.sshHost,
            '-o',
            'ConnectTimeout=5',
            '-o',
            'StrictHostKeyChecking=no',
            '-o',
            'BatchMode=yes',
            'bash',
            '-s'
          ],
          { stdio: ['pipe', 'pipe', 'ignore'] }
        )
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('timed out'))
    }, timeoutMs)
    child.stdout!.on('data', (d) => (out += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || out.includes('@@')) resolve(out)
      else reject(new Error(code === 255 ? 'SSH failed' : `exit ${code}`))
    })
    child.stdin!.on('error', () => {})
    child.stdin!.end(script + '\n')
  })
}

function defaultTailscaleStatus(): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile('tailscale', ['status', '--json'], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err)
      else {
        try {
          resolve(JSON.parse(stdout))
        } catch (e) {
          reject(e)
        }
      }
    })
  })
}

/** Tailscale's node list as scan targets. */
export function targetsFromTailscale(status: any, overrides: Record<string, DeviceOverride>): NetTarget[] {
  const targets: NetTarget[] = []
  const add = (node: any, hub: boolean) => {
    const hostname: string = node.HostName
    const override = findOverride(overrides, hostname)
    if (override?.exclude) return
    const online = hub || !!node.Online
    targets.push({
      id: `ts:${hostname.toLowerCase()}`,
      label: override?.label ?? hostname,
      os: node.OS,
      online,
      hub,
      scannable: online && !SKIP_OS.has(node.OS),
      sshHost: override?.sshHost ?? node.DNSName?.replace(/\.$/, '') ?? hostname,
      tailscaleIPs: node.TailscaleIPs ?? [],
      ...(hub
        ? {}
        : {
            tailnet: {
              curAddr: node.CurAddr ?? '',
              relay: node.Relay ?? '',
              active: !!node.Active,
              bytes: (node.RxBytes ?? 0) + (node.TxBytes ?? 0)
            }
          })
    })
  }
  if (status?.Self) add(status.Self, true)
  for (const peer of Object.values<any>(status?.Peer ?? {})) add(peer, false)
  return targets
}

export function createNetworkMonitor(options: NetworkMonitorOptions = {}) {
  const overrides = options.overrides ?? {}
  const cacheTtl = options.cacheTtlMs ?? 8_000
  const timeoutMs = options.timeoutMs ?? 10_000
  const runScript = options.runScript ?? defaultRunScript
  const tailscaleStatus = options.tailscaleStatus ?? defaultTailscaleStatus

  let cache: NetworkMap | null = null
  let inflight: Promise<NetworkMap> | null = null
  // Counters from the last scan, for rates.
  let last: { at: number; tailnet: Map<string, number>; netdev: Map<string, { rx: number; tx: number }> } | null = null

  const lanLabels = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [key, o] of Object.entries(overrides)) if (isV4(key) && o.label) out[key] = o.label
    return out
  }

  async function scan(): Promise<NetworkMap> {
    let targets: NetTarget[]
    try {
      targets = targetsFromTailscale(await tailscaleStatus(), overrides)
    } catch {
      const hostname = os.hostname()
      const override = findOverride(overrides, hostname)
      targets = [
        {
          id: `ts:${hostname.toLowerCase()}`,
          label: override?.label ?? hostname,
          os: os.platform() === 'darwin' ? 'macOS' : os.platform(),
          online: true,
          hub: true,
          scannable: true,
          sshHost: hostname,
          tailscaleIPs: []
        }
      ]
    }

    const [results, metrics] = await Promise.all([
      Promise.all(
        targets.map(async (target) => {
          if (!target.scannable) return { target }
          const macos = target.os.toLowerCase() === 'macos' || findOverride(overrides, target.label)?.osHint === 'macos'
          try {
            const raw = await runScript(target, macos ? MACOS_SCRIPT : LINUX_SCRIPT, timeoutMs)
            return { target, scan: parseScan(raw, macos) }
          } catch (err: any) {
            return { target, error: `scan failed: ${err?.message ?? err}` }
          }
        })
      ),
      options.deviceMonitor?.getMetrics().catch(() => []) ?? Promise.resolve([])
    ])

    const now = Date.now()
    const traffic: Record<string, { rxBps: number; txBps: number }> = {}
    const tailnetRates: Record<string, number> = {}
    const next = { at: now, tailnet: new Map<string, number>(), netdev: new Map<string, { rx: number; tx: number }>() }
    const dt = last ? (now - last.at) / 1000 : 0
    for (const r of results) {
      const id = r.target.id
      if (r.scan?.netdev) {
        next.netdev.set(id, r.scan.netdev)
        const prev = last?.netdev.get(id)
        if (prev && dt > 0) {
          traffic[id] = {
            rxBps: Math.max(0, (r.scan.netdev.rx - prev.rx) / dt),
            txBps: Math.max(0, (r.scan.netdev.tx - prev.tx) / dt)
          }
        }
      }
      if (r.target.tailnet) {
        next.tailnet.set(id, r.target.tailnet.bytes)
        const prev = last?.tailnet.get(id)
        if (prev !== undefined && dt > 0) tailnetRates[id] = Math.max(0, (r.target.tailnet.bytes - prev) / dt)
      }
    }
    last = next

    return buildNetworkMap({ targets: results, metrics, lanLabels: lanLabels(), traffic, tailnetRates, now })
  }

  /** The cached map, or a fresh scan. Concurrent callers share one scan. */
  async function getMap(): Promise<NetworkMap> {
    if (cache && Date.now() - cache.collectedAt < cacheTtl) return cache
    if (inflight) return inflight
    inflight = scan()
      .then((map) => (cache = map))
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  return { getMap }
}

export type NetworkMonitor = ReturnType<typeof createNetworkMonitor>
