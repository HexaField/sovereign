import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }))

import {
  deviceOf,
  edgePath,
  focusHandlers,
  groupServices,
  isUnnamed,
  visibleLinks,
  type NetLink,
  type NetService
} from './NetworkTab.jsx'

const service = (name: string, role: NetService['role'], ports: number[] = [1]): NetService => ({
  id: `d/${name}`,
  name,
  role,
  ports
})

const links: NetLink[] = [
  { id: '1', from: 'gw:1', to: 'internet', kind: 'wan' },
  { id: '2', from: 'ts:hub', to: 'ts:worker', kind: 'tailnet', path: 'direct' },
  { id: '3', from: 'ts:hub/sovereign', to: 'ts:hub/litellm', kind: 'tcp', connections: 1 },
  { id: '4', from: 'ts:hub/sovereign', to: 'ts:worker/SSH', kind: 'tcp', connections: 2 },
  { id: '5', from: 'ts:hub/litellm', to: 'ts:hub/llama-server', kind: 'tcp', connections: 1 },
  { id: '6', from: 'ts:hub/Tailscale Serve', to: 'ts:hub/sovereign', kind: 'proxy' },
  { id: '7', from: 'ts:hub/sovereign', to: 'internet', kind: 'tcp', connections: 9 }
]
const ids = (ls: NetLink[]) => ls.map((l) => l.id)

describe('deviceOf', () => {
  it('takes the device part of a service id and keeps a device id', () => {
    expect(deviceOf('ts:hub/sovereign')).toBe('ts:hub')
    expect(deviceOf('ts:hub/a/b')).toBe('ts:hub')
    expect(deviceOf('internet')).toBe('internet')
  })
})

describe('isUnnamed', () => {
  it('flags bare ports and the Tailscale peer API only', () => {
    expect(isUnnamed(service('port 43433', 'system', [43433]))).toBe(true)
    expect(isUnnamed(service('Tailscale', 'system', [1]))).toBe(true)
    expect(isUnnamed(service('Tailscale Serve', 'system', [5801]))).toBe(false)
    expect(isUnnamed(service('sovereign', 'system', [5801]))).toBe(false)
  })
})

describe('visibleLinks', () => {
  it('shows device links and cross-device service links, not Internet ones, without a focus', () => {
    expect(ids(visibleLinks(links, null))).toEqual(['1', '2', '4'])
  })

  it('shows every link of a focused service, inside the machine too', () => {
    expect(ids(visibleLinks(links, 'ts:hub/sovereign'))).toEqual(['1', '2', '3', '4', '6', '7'])
  })

  it('shows every link touching a focused device', () => {
    expect(ids(visibleLinks(links, 'ts:worker'))).toEqual(['1', '2', '4'])
  })
})

describe('focusHandlers', () => {
  const setup = () => {
    const calls: Array<[string | null, boolean]> = []
    const h = focusHandlers(
      () => 'ts:hub/sovereign',
      () => (id, sticky) => calls.push([id, sticky]),
      () => 'ts:hub'
    )
    return { h, calls }
  }
  const pointer = (pointerType: string) => ({ pointerType }) as PointerEvent

  it('hovers with a mouse and hands the hover back to the card on leave', () => {
    const { h, calls } = setup()
    h.onPointerEnter(pointer('mouse'))
    h.onPointerLeave(pointer('mouse'))
    expect(calls).toEqual([
      ['ts:hub/sovereign', false],
      ['ts:hub', false]
    ])
  })

  it('ignores touch hover, so a tap only pins', () => {
    const { h, calls } = setup()
    h.onPointerEnter(pointer('touch'))
    h.onClick({ stopPropagation: () => {} } as MouseEvent)
    expect(calls).toEqual([['ts:hub/sovereign', true]])
  })
})

describe('edgePath', () => {
  const box = (x: number, y: number) => ({ x, y, w: 100, h: 20 })

  it('runs from the bottom of the upper box to the top of the lower one', () => {
    expect(edgePath(box(0, 0), box(200, 100))).toBe('M 50 20 C 50 60, 250 60, 250 100')
    expect(edgePath(box(200, 100), box(0, 0))).toBe('M 250 100 C 250 60, 50 60, 50 20')
  })

  it('loops out to the right between boxes at the same height', () => {
    expect(edgePath(box(0, 0), box(0, 10))).toBe('M 100 10 C 126.5 10, 126.5 20, 100 20')
  })
})

describe('groupServices', () => {
  it('sorts services into fixed sections, by name, with outbound-only processes last', () => {
    const groups = groupServices([
      service('whisper', 'service'),
      service('Brave', 'app', []),
      service('SSH', 'system'),
      service('ad4m', 'container'),
      service('litellm', 'service'),
      service('VS Code', 'app')
    ])
    expect(groups.map((g) => [g.label, g.services.map((s) => s.name)])).toEqual([
      ['Services', ['litellm', 'whisper']],
      ['Docker', ['ad4m']],
      ['Apps', ['VS Code']],
      ['System', ['SSH']],
      ['Connects out', ['Brave']]
    ])
  })

  it('leaves out empty sections', () => {
    expect(groupServices([service('SSH', 'system')]).map((g) => g.label)).toEqual(['System'])
  })
})
