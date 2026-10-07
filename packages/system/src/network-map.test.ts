import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  buildNetworkMap,
  createNetworkMonitor,
  parseLsof,
  parseScan,
  parseSs,
  splitHostPort,
  targetsFromTailscale,
  type NetTarget
} from './network-map.js'
import { createSystemRoutes } from './routes.js'

// ── Fixtures: what the scan scripts print ──

const HUB_RAW = `@@LISTEN@@
LISTEN 0      2048        127.0.0.1:4000  0.0.0.0:* users:(("litellm",pid=100,fd=14))
LISTEN 0      511         127.0.0.1:5801  0.0.0.0:* users:(("node-MainThread",pid=200,fd=31))
LISTEN 0      512           0.0.0.0:9090  0.0.0.0:* users:(("llama-server",pid=300,fd=8))
LISTEN 0      4096          0.0.0.0:3101  0.0.0.0:*
LISTEN 0      4096             [::]:3101     [::]:*
LISTEN 0      4096          0.0.0.0:22    0.0.0.0:*
LISTEN 0      4096     100.64.0.1:5801    0.0.0.0:*
LISTEN 0      4096     100.64.0.1:43433   0.0.0.0:*
@@ESTAB@@
0      0      127.0.0.1:41000   127.0.0.1:4000  users:(("node-MainThread",pid=200,fd=40))
0      0      127.0.0.1:4000   127.0.0.1:41000  users:(("litellm",pid=100,fd=20))
0      0      127.0.0.1:41002   127.0.0.1:9090  users:(("litellm",pid=100,fd=21))
0      0      127.0.0.1:41004   127.0.0.1:3101  users:(("node-MainThread",pid=200,fd=41))
0      0      127.0.0.1:41006   127.0.0.1:3101  users:(("node-MainThread",pid=200,fd=42))
0      0      192.168.1.3:41008  160.79.104.10:443  users:(("node-MainThread",pid=200,fd=43))
0      0      192.168.1.3:41010  160.79.104.10:443  users:(("claude",pid=400,fd=9))
0      0      100.64.0.1:5801   100.64.0.9:50137
0      0      100.64.0.1:41012  100.64.0.2:22  users:(("ssh",pid=500,fd=3))
0      0      127.0.0.1:41014   127.0.0.1:5801
0      0      100.64.0.1:41016  100.64.0.9:22  users:(("ssh",pid=500,fd=4))
@@PROCS@@
100\tlitellm.service\t/usr/bin/python3 /home/u/.local/bin/litellm --config c.yaml
200\tsovereign.service\t/usr/bin/node /srv/sovereign/packages/server/dist/index.js
300\tllama-server.service\t/opt/llama/llama-server --model kat.gguf
400\tsession-3.scope\t/usr/bin/claude --print
500\tsovereign.service\tssh field -o BatchMode=yes bash -s
@@ADDR@@
lo 127.0.0.1/8
enp1s0 192.168.1.3/24
tailscale0 100.64.0.1/32
docker0 172.17.0.1/16
@@ROUTE@@
default via 192.168.1.1 dev enp1s0 proto static metric 100
@@NEIGH@@
192.168.1.1 dev enp1s0 lladdr 74:24:9f:d6:23:ab REACHABLE
192.168.1.216 dev enp1s0 lladdr 58:05:d9:4a:01:d6 STALE
192.168.1.98 dev enp1s0 lladdr 72:2d:5c:d3:ad:ca STALE
192.168.1.20 dev enp1s0 FAILED
192.168.1.199 dev enp1s0 lladdr 08:bf:b8:85:bb:8d REACHABLE
172.17.0.2 dev docker0 lladdr 02:42:ac:11:00:02 REACHABLE
@@DOCKER@@
ad4m-prod\t0.0.0.0:3101->3001/tcp, [::]:3101->3001/tcp
@@SERVE@@
{ "TCP": { "5801": { "HTTPS": true } },
  "Web": { "hub.ts.net:5801": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:5801" } } } } }
@@NETDEV@@
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0
enp1s0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0
tailscale0: 70 1 0 0 0 0 0 0 80 1 0 0 0 0 0 0
@@CPU@@
 AMD RYZEN AI MAX+ 395 w/ Radeon 8060S
32
@@MEM@@
131890843648
@@GPU@@
 Advanced Micro Devices, Inc. [AMD/ATI] Strix Halo [Radeon Graphics / Radeon 8050S Graphics / Radeon 8060S Graphics] (rev c1)
@@AUDIO@@
HD-Audio Generic
@@VIDEO@@
1080P Webcam: 1080P Webcam
1080P Webcam
@@DISK@@
nvme0n1 4000787030016 disk WD_BLACK SN7100 4TB
zram0 8589934592 disk
`

const WORKER_RAW = `@@LISTEN@@
LISTEN 0      4096          0.0.0.0:22    0.0.0.0:*
LISTEN 0      4096        127.0.0.1:11434 0.0.0.0:* users:(("ollama",pid=10,fd=3))
@@ESTAB@@
0      0      100.64.0.2:22   100.64.0.1:41012
@@PROCS@@
10\tollama.service\t/usr/local/bin/ollama serve
@@ADDR@@
enp2s0 192.168.1.199/24
tailscale0 100.64.0.2/32
docker0 172.17.0.1/16
@@ROUTE@@
default via 192.168.1.1 dev enp2s0
@@NETDEV@@
enp2s0: 500 1 0 0 0 0 0 0 600 1 0 0 0 0 0 0
@@CPU@@
 AMD Ryzen 5 5500
12
@@MEM@@
33439350784
@@GPU@@
 NVIDIA Corporation TU106 [GeForce RTX 2060 Rev. A] (rev a1)
`

const MAC_RAW = `@@LSOF_LISTEN@@
p684
cCode Helper (Plugin)
f36
n127.0.0.1:3000
p700
cOllama
f5
n*:11434
@@LSOF_ESTAB@@
p800
cBrave Browser Helper
f20
n100.64.0.9:50137->100.64.0.1:5801
f21
n192.168.1.217:50140->142.250.70.78:443
p900
csshd-session
f5
n100.64.0.9:22->100.64.0.1:41016
f6
n100.64.0.9:22->100.64.0.1:41016
@@LISTEN_ALL@@
tcp4 127.0.0.1.3000
tcp4 *.22
tcp6 *.22
tcp6 fd7a:115c:a1e0::.5801
@@PROCS@@
684\t\t/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Code Helper (Plugin)
800\t\t/Applications/Brave Browser.app/Contents/Frameworks/Brave Browser Helper
@@ADDR@@
lo0 127.0.0.1
en0 192.168.1.217
utun4 100.64.0.9
@@ROUTE@@
default via 192.168.1.1 dev en0
@@ARP@@
? (192.168.1.1) at 74:24:9f:d6:23:ab on en0 ifscope [ethernet]
? (192.168.1.50) at (incomplete) on en0 ifscope [ethernet]
? (192.168.1.60) at 9c:bf:d:1:ec:d8 on en0 ifscope [ethernet]
? (192.168.1.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]
? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]
@@NETSTAT@@
Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                      60 0 3478 60 0 3478 0
en0        1500  <Link#11>   a0:b1:c2:d3:e4:f5  900 0 123456 800 0 654321 0
en0        1500  192.168.1     192.168.1.217    900 - 123456 800 - 654321 -
@@CPU@@
Apple M4 Pro
14
@@MEM@@
51539607552
`

const TAILSCALE = {
  Self: { HostName: 'hub', OS: 'linux', TailscaleIPs: ['100.64.0.1'] },
  Peer: {
    a: {
      HostName: 'Worker',
      DNSName: 'worker.ts.net.',
      OS: 'linux',
      Online: true,
      Active: true,
      CurAddr: '[2406::1]:41641',
      Relay: 'syd',
      RxBytes: 1000,
      TxBytes: 1000,
      TailscaleIPs: ['100.64.0.2']
    },
    b: {
      HostName: 'Laptop',
      DNSName: 'laptop.ts.net.',
      OS: 'macOS',
      Online: true,
      Active: true,
      CurAddr: '192.168.1.217:41641',
      Relay: 'syd',
      RxBytes: 0,
      TxBytes: 0,
      TailscaleIPs: ['100.64.0.9']
    },
    c: {
      HostName: 'Phone',
      DNSName: 'phone.ts.net.',
      OS: 'android',
      Online: true,
      Active: false,
      CurAddr: '',
      Relay: 'syd',
      TailscaleIPs: ['100.64.0.7']
    },
    d: { HostName: 'Gone', OS: 'linux', Online: false, TailscaleIPs: ['100.64.0.8'] }
  }
}

const OVERRIDES = {
  hub: { label: 'Hub' },
  worker: { label: 'Field Server', sshHost: 'field' },
  gone: { exclude: true },
  '192.168.1.216': { label: 'Printer' }
}

function scanned(): Parameters<typeof buildNetworkMap>[0]['targets'] {
  const targets = targetsFromTailscale(TAILSCALE, OVERRIDES)
  const raw: Record<string, [string, boolean]> = {
    'ts:hub': [HUB_RAW, false],
    'ts:worker': [WORKER_RAW, false],
    'ts:laptop': [MAC_RAW, true]
  }
  return targets.map((target) =>
    raw[target.id] ? { target, scan: parseScan(raw[target.id][0], raw[target.id][1]) } : { target }
  )
}

const svc = (map: ReturnType<typeof buildNetworkMap>, deviceId: string, name: string) =>
  map.devices.find((d) => d.id === deviceId)?.services.find((s) => s.name === name)
const link = (map: ReturnType<typeof buildNetworkMap>, from: string, to: string) =>
  map.links.find((l) => l.from === from && l.to === to)

// ── Parsing ──

describe('splitHostPort', () => {
  it('reads IPv4, bracketed IPv6, wildcards and zones', () => {
    expect(splitHostPort('127.0.0.1:4000')).toEqual({ ip: '127.0.0.1', port: 4000 })
    expect(splitHostPort('[fd7a::1]:5801')).toEqual({ ip: 'fd7a::1', port: 5801 })
    expect(splitHostPort('[::]:22')).toEqual({ ip: '0.0.0.0', port: 22 })
    expect(splitHostPort('*:80')).toEqual({ ip: '0.0.0.0', port: 80 })
    expect(splitHostPort('127.0.0.53%lo:53')).toEqual({ ip: '127.0.0.53', port: 53 })
    expect(splitHostPort('[::ffff:10.0.0.1]:8')).toEqual({ ip: '10.0.0.1', port: 8 })
    expect(splitHostPort('0.0.0.0:*')).toEqual({ ip: '0.0.0.0', port: 0 })
    expect(splitHostPort('nonsense')).toBeNull()
  })
})

describe('parseSs', () => {
  it('reads listening and established lines, with and without a process', () => {
    const rows = parseSs([
      'LISTEN 0 2048 127.0.0.1:4000 0.0.0.0:* users:(("litellm",pid=100,fd=14))',
      '0 0 100.64.0.1:5801 100.64.0.9:50137'
    ])
    expect(rows[0].local).toEqual({ ip: '127.0.0.1', port: 4000, comm: 'litellm', pid: 100 })
    expect(rows[1]).toEqual({ local: { ip: '100.64.0.1', port: 5801 }, peer: { ip: '100.64.0.9', port: 50137 } })
  })
})

describe('parseLsof', () => {
  it('keeps the process across file records and splits connections', () => {
    const rows = parseLsof(['p800', 'cBrave', 'f20', 'n10.0.0.1:1->10.0.0.2:443', 'f21', 'n*:8080'])
    expect(rows[0]).toEqual({
      local: { ip: '10.0.0.1', port: 1, pid: 800, comm: 'Brave' },
      peer: { ip: '10.0.0.2', port: 443 }
    })
    expect(rows[1]).toEqual({ local: { ip: '0.0.0.0', port: 8080, pid: 800, comm: 'Brave' } })
  })
})

describe('parseScan', () => {
  it('reads every section of a Linux scan', () => {
    const scan = parseScan(HUB_RAW, false)
    // 0.0.0.0:3101 and [::]:3101 are one wildcard listener.
    expect(scan.listen).toHaveLength(7)
    expect(scan.estab).toHaveLength(11)
    expect(scan.procs.get(200)).toEqual({
      unit: 'sovereign.service',
      args: '/usr/bin/node /srv/sovereign/packages/server/dist/index.js'
    })
    expect(scan.gateway).toEqual({ ip: '192.168.1.1', iface: 'enp1s0' })
    // FAILED entries carry no MAC and drop out.
    expect(scan.neigh.map((n) => n.ip)).toEqual([
      '192.168.1.1',
      '192.168.1.216',
      '192.168.1.98',
      '192.168.1.199',
      '172.17.0.2'
    ])
    expect(scan.docker).toEqual([{ name: 'ad4m-prod', ports: [3101] }])
    expect(scan.serve).toEqual([{ port: 5801, target: 5801 }])
    expect(scan.netdev).toEqual({ rx: 1000, tx: 2000 })
    expect(scan.hardware).toEqual({
      cpu: 'AMD RYZEN AI MAX+ 395 w/ Radeon 8060S',
      cores: 32,
      memoryBytes: 131890843648,
      gpus: ['Radeon 8060S Graphics'],
      disks: [{ name: 'nvme0n1', bytes: 4000787030016, model: 'WD_BLACK SN7100 4TB' }],
      peripherals: ['HD-Audio Generic', '1080P Webcam']
    })
  })

  it('reads a macOS scan', () => {
    const scan = parseScan(MAC_RAW, true)
    // netstat adds the root-owned sshd listener; truncated IPv6 and duplicates drop out.
    expect(scan.listen).toEqual([
      { ip: '127.0.0.1', port: 3000, pid: 684, comm: 'Code Helper (Plugin)' },
      { ip: '0.0.0.0', port: 11434, pid: 700, comm: 'Ollama' },
      { ip: '0.0.0.0', port: 22 }
    ])
    // lsof lists the sshd socket once per fd.
    expect(scan.estab).toHaveLength(3)
    // Short MAC octets are padded; broadcast and multicast entries are not devices.
    expect(scan.neigh).toEqual([
      { ip: '192.168.1.1', mac: '74:24:9f:d6:23:ab', iface: 'en0' },
      { ip: '192.168.1.60', mac: '9c:bf:0d:01:ec:d8', iface: 'en0' }
    ])
    expect(scan.netdev).toEqual({ rx: 123456, tx: 654321 })
    expect(scan.hardware.cpu).toBe('Apple M4 Pro')
    expect(scan.hardware.memoryBytes).toBe(51539607552)
  })
})

// ── Build ──

describe('targetsFromTailscale', () => {
  it('applies overrides, skips excluded nodes and marks what SSH can reach', () => {
    const targets = targetsFromTailscale(TAILSCALE, OVERRIDES)
    expect(targets.map((t) => t.id)).toEqual(['ts:hub', 'ts:worker', 'ts:laptop', 'ts:phone'])
    const byId = Object.fromEntries(targets.map((t) => [t.id, t]))
    expect(byId['ts:hub']).toMatchObject({ label: 'Hub', hub: true, scannable: true })
    expect(byId['ts:worker']).toMatchObject({ label: 'Field Server', sshHost: 'field', scannable: true })
    expect(byId['ts:laptop'].sshHost).toBe('laptop.ts.net')
    expect(byId['ts:phone'].scannable).toBe(false)
    expect(byId['ts:worker'].tailnet).toEqual({ curAddr: '[2406::1]:41641', relay: 'syd', active: true, bytes: 2000 })
    expect(targets.map((t) => t.macos)).toEqual([false, false, true, false])
  })

  it('takes the macOS hint from the override keyed by hostname, not by label', () => {
    const [, worker] = targetsFromTailscale(TAILSCALE, { worker: { label: 'Field Server', osHint: 'macos' } })
    expect(worker).toMatchObject({ label: 'Field Server', macos: true })
  })
})

describe('buildNetworkMap', () => {
  const map = buildNetworkMap({ targets: scanned(), lanLabels: { '192.168.1.216': 'Printer' }, now: 1 })

  it('names listeners by Docker container, systemd unit, Tailscale and well-known port', () => {
    expect(svc(map, 'ts:hub', 'sovereign')).toMatchObject({
      ports: [5801],
      exposure: 'loopback',
      unit: 'sovereign.service'
    })
    expect(svc(map, 'ts:hub', 'llama-server')).toMatchObject({ ports: [9090], exposure: 'network' })
    expect(svc(map, 'ts:hub', 'ad4m-prod')).toMatchObject({ ports: [3101], unit: 'docker:ad4m-prod' })
    expect(svc(map, 'ts:hub', 'Tailscale Serve')).toMatchObject({ ports: [5801], exposure: 'tailnet' })
    expect(svc(map, 'ts:hub', 'Tailscale')).toMatchObject({ ports: [43433] })
    expect(svc(map, 'ts:hub', 'SSH')).toMatchObject({ ports: [22] })
    expect(svc(map, 'ts:laptop', 'VS Code')).toMatchObject({ ports: [3000] })
  })

  it('gives each service the role of what runs it', () => {
    const role = (dev: string, name: string) => svc(map, dev, name)?.role
    expect(role('ts:hub', 'sovereign')).toBe('service')
    expect(role('ts:hub', 'ad4m-prod')).toBe('container')
    expect(role('ts:hub', 'SSH')).toBe('system')
    expect(role('ts:hub', 'Tailscale Serve')).toBe('system')
    expect(role('ts:hub', 'Claude Code')).toBe('app')
    expect(role('ts:laptop', 'VS Code')).toBe('app')
    expect(role('ts:worker', 'ollama')).toBe('service')
  })

  it('links client processes to the listener they reach, counting connections', () => {
    expect(link(map, 'ts:hub/sovereign', 'ts:hub/litellm')).toMatchObject({ kind: 'tcp', connections: 1 })
    expect(link(map, 'ts:hub/litellm', 'ts:hub/llama-server')).toMatchObject({ connections: 1 })
    expect(link(map, 'ts:hub/sovereign', 'ts:hub/ad4m-prod')).toMatchObject({ connections: 2 })
  })

  it('follows connections across devices to the remote listener', () => {
    // ssh runs inside sovereign.service, so it counts as Sovereign.
    expect(link(map, 'ts:hub/sovereign', 'ts:worker/SSH')).toMatchObject({ connections: 1 })
    expect(link(map, 'ts:laptop/Brave', 'ts:hub/Tailscale Serve')).toMatchObject({ connections: 1 })
    // The worker's server-side socket does not double-count the hub's connection.
    expect(map.links.filter((l) => l.to === 'ts:worker/SSH')).toHaveLength(1)
  })

  it('groups public destinations under the Internet', () => {
    expect(link(map, 'ts:hub/sovereign', 'internet')).toMatchObject({ connections: 1 })
    expect(link(map, 'ts:hub/Claude Code', 'internet')).toMatchObject({ connections: 1 })
    expect(link(map, 'ts:laptop/Brave', 'internet')).toMatchObject({ connections: 1 })
  })

  it('draws the Tailscale Serve proxy and drops unattributed loopback clients', () => {
    expect(link(map, 'ts:hub/Tailscale Serve', 'ts:hub/sovereign')).toMatchObject({ kind: 'proxy' })
    expect(map.links.some((l) => l.from === 'ts:hub' && l.to.startsWith('ts:hub/'))).toBe(false)
  })

  it('maps the LAN: gateway, Internet, scanned hosts and neighbours', () => {
    const gw = map.devices.find((d) => d.kind === 'gateway')!
    expect(gw).toMatchObject({ id: 'gw:192.168.1.1', label: 'Router 192.168.1.1' })
    expect(link(map, 'gw:192.168.1.1', 'internet')?.kind).toBe('wan')
    for (const id of ['ts:hub', 'ts:worker', 'ts:laptop', 'lan:192.168.1.216', 'lan:192.168.1.98']) {
      expect(link(map, 'gw:192.168.1.1', id)?.kind).toBe('lan')
    }
    // Known hosts and other subnets never show up as anonymous LAN devices.
    expect(map.devices.some((d) => d.id === 'lan:192.168.1.199' || d.id === 'lan:172.17.0.2')).toBe(false)
    expect(map.devices.find((d) => d.id === 'lan:192.168.1.216')?.label).toBe('Printer')
    expect(map.devices.find((d) => d.id === 'lan:192.168.1.98')?.label).toBe('Wi-Fi device 192.168.1.98')
  })

  it('gives each tailnet peer its path from the hub', () => {
    expect(link(map, 'ts:hub', 'ts:worker')).toMatchObject({ kind: 'tailnet', path: 'direct', active: true })
    expect(link(map, 'ts:hub', 'ts:laptop')).toMatchObject({ path: 'LAN' })
    expect(link(map, 'ts:hub', 'ts:phone')).toMatchObject({ path: 'relay syd', active: false })
    expect(map.devices.find((d) => d.id === 'ts:phone')).toMatchObject({ kind: 'phone', services: [] })
  })

  it('counts a connection once when the server side has no pid', () => {
    // The laptop's sshd listener comes from netstat; its session socket is skipped as server side.
    expect(link(map, 'ts:hub/sovereign', 'ts:laptop/SSH')).toMatchObject({ connections: 1 })
    expect(map.links.filter((l) => l.from.startsWith('ts:laptop/SSH'))).toEqual([])
  })

  it('reads an address two devices share (docker0) as this device', () => {
    const targets = scanned()
    const hub = targets.find((t) => t.target.id === 'ts:hub')!
    hub.scan!.estab.push({ local: { ip: '172.17.0.1', port: 41030, pid: 100 }, peer: { ip: '172.17.0.1', port: 9090 } })
    const m = buildNetworkMap({ targets })
    expect(link(m, 'ts:hub/litellm', 'ts:hub/llama-server')).toMatchObject({ connections: 2 })
    expect(m.links.some((l) => l.from === 'ts:hub/litellm' && l.to.startsWith('ts:worker'))).toBe(false)
  })

  it('counts a connection between two unlistened ports once, from the higher port', () => {
    const targets = scanned()
    const sock = (ip: string, port: number) => ({ ip, port })
    targets
      .find((t) => t.target.id === 'ts:hub')!
      .scan!.estab.push({ local: { ...sock('100.64.0.1', 7000), pid: 300 }, peer: sock('100.64.0.2', 45000) })
    targets
      .find((t) => t.target.id === 'ts:worker')!
      .scan!.estab.push({ local: { ...sock('100.64.0.2', 45000), pid: 10 }, peer: sock('100.64.0.1', 7000) })
    const m = buildNetworkMap({ targets })
    expect(link(m, 'ts:worker/ollama', 'ts:hub')).toMatchObject({ connections: 1 })
    expect(link(m, 'ts:hub/llama-server', 'ts:worker')).toBeUndefined()
  })

  it('records an inbound connection from a device nobody scans', () => {
    const targets = scanned()
    const hub = targets.find((t) => t.target.id === 'ts:hub')!
    hub.scan!.estab.push({ local: { ip: '100.64.0.1', port: 5801 }, peer: { ip: '100.64.0.7', port: 40000 } })
    const m = buildNetworkMap({ targets })
    expect(link(m, 'ts:phone', 'ts:hub/Tailscale Serve')).toMatchObject({ kind: 'tcp', connections: 1 })
  })

  it('takes usage and the GPU name from device-monitor metrics', () => {
    const m = buildNetworkMap({
      targets: scanned(),
      metrics: [
        {
          hostname: 'Field Server',
          os: 'linux',
          online: true,
          tailscaleIP: null,
          local: false,
          collectedAt: 0,
          cpu: { cores: 12, usagePercent: 40, loadAvg: [1, 1, 1] },
          memory: { totalBytes: 100, usedBytes: 25, availableBytes: 75 },
          gpu: { name: 'NVIDIA GeForce RTX 2060', memoryTotalMB: 6144, memoryUsedMB: 1, usagePercent: 99, tempC: 60 }
        }
      ]
    })
    const worker = m.devices.find((d) => d.id === 'ts:worker')!
    expect(worker.usage).toEqual({ cpuPercent: 40, memoryPercent: 25, gpuPercent: 99 })
    expect(worker.hardware?.gpus).toEqual(['NVIDIA GeForce RTX 2060 · 6 GB'])
  })
})

// ── Monitor ──

describe('createNetworkMonitor', () => {
  const raws: Record<string, string> = { 'ts:hub': HUB_RAW, 'ts:worker': WORKER_RAW, 'ts:laptop': MAC_RAW }

  it('scans each reachable device with its own script and reports failures per device', async () => {
    const seen: Array<[string, boolean]> = []
    const monitor = createNetworkMonitor({
      overrides: OVERRIDES,
      tailscaleStatus: async () => TAILSCALE,
      runScript: async (t: NetTarget, script: string) => {
        seen.push([t.id, script.includes('lsof')])
        if (t.id === 'ts:worker') throw new Error('SSH failed')
        return raws[t.id]
      }
    })
    const map = await monitor.getMap()
    expect(seen.sort()).toEqual([
      ['ts:hub', false],
      ['ts:laptop', true],
      ['ts:worker', false]
    ])
    expect(map.devices.find((d) => d.id === 'ts:worker')?.error).toBe('scan failed: SSH failed')
    expect(map.devices.find((d) => d.id === 'ts:hub')?.services.length).toBeGreaterThan(0)
  })

  it('caches within the TTL, shares a scan between callers and turns counters into rates', async () => {
    let scans = 0
    const status = structuredClone(TAILSCALE)
    let hub = HUB_RAW
    const monitor = createNetworkMonitor({
      overrides: OVERRIDES,
      cacheTtlMs: 0,
      tailscaleStatus: async () => status,
      runScript: async (t: NetTarget) => {
        if (t.id === 'ts:hub') scans++
        return t.id === 'ts:hub' ? hub : raws[t.id]
      }
    })
    const [a, b] = await Promise.all([monitor.getMap(), monitor.getMap()])
    expect(a).toBe(b)
    expect(scans).toBe(1)
    expect(a.devices.find((d) => d.id === 'ts:hub')?.traffic).toBeUndefined()

    await new Promise((r) => setTimeout(r, 20))
    status.Peer.a.RxBytes += 5000
    hub = HUB_RAW.replace('enp1s0: 1000', 'enp1s0: 3000')
    const c = await monitor.getMap()
    expect(scans).toBe(2)
    expect(c.devices.find((d) => d.id === 'ts:hub')?.traffic?.rxBps).toBeGreaterThan(0)
    expect(c.links.find((l) => l.to === 'ts:worker' && l.kind === 'tailnet')?.rateBps).toBeGreaterThan(0)
  })

  it('falls back to this machine alone without Tailscale', async () => {
    const monitor = createNetworkMonitor({
      tailscaleStatus: async () => {
        throw new Error('no tailscale')
      },
      runScript: async () => WORKER_RAW
    })
    const map = await monitor.getMap()
    expect(map.devices.filter((d) => d.kind === 'host')).toHaveLength(1)
    expect(map.devices[0].hub).toBe(true)
  })
})

describe('GET /api/system/network', () => {
  it('serves the map', async () => {
    const app = express()
    const networkMonitor = {
      getMap: async () => ({ collectedAt: 5, devices: [], links: [] })
    }
    app.use(createSystemRoutes({ system: {} as any, networkMonitor } as any))
    const res = await request(app).get('/api/system/network')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ collectedAt: 5, devices: [], links: [] })
  })
})
