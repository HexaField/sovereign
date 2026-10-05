import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSpeechQueue, type SpeechPlayer } from './tts-queue.js'

/** A player that records what it plays; each clip "plays" for 100 ms. */
function recordingPlayer() {
  const log: string[] = []
  let stopCurrent: (() => void) | null = null
  const player: SpeechPlayer = {
    play: (clip) =>
      new Promise<void>((resolve) => {
        log.push(new TextDecoder().decode(clip))
        const timer = setTimeout(resolve, 100)
        stopCurrent = () => {
          clearTimeout(timer)
          log.push('(stopped)')
          resolve()
        }
      }),
    cue: async () => {
      log.push('cue')
    },
    stop: () => stopCurrent?.()
  }
  return { player, log }
}

const clip = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

describe('speech queue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('plays two replies whose chunks interleave one whole reply at a time, with a cue between', async () => {
    const { player, log } = recordingPlayer()
    const q = createSpeechQueue(player)
    q.enqueue({ utterance: 'A', clip: clip('A0'), last: false })
    q.enqueue({ utterance: 'B', clip: clip('B0'), last: false })
    q.enqueue({ utterance: 'A', clip: clip('A1'), last: false })
    q.enqueue({ utterance: 'B', clip: clip('B1'), last: true })
    q.enqueue({ utterance: 'A', clip: clip('A2'), last: true })
    await vi.runAllTimersAsync()

    expect(log).toEqual(['A0', 'A1', 'A2', 'cue', 'B0', 'B1'])
    expect(q.active()).toBe(false)
  })

  it('waits for a reply’s late chunk instead of jumping to the next reply', async () => {
    const { player, log } = recordingPlayer()
    const q = createSpeechQueue(player)
    q.enqueue({ utterance: 'A', clip: clip('A0'), last: false })
    q.enqueue({ utterance: 'B', clip: clip('B0'), last: true })
    await vi.advanceTimersByTimeAsync(2000) // A0 done, A1 still synthesising
    expect(log).toEqual(['A0'])

    q.enqueue({ utterance: 'A', clip: clip('A1'), last: true })
    await vi.runAllTimersAsync()
    expect(log).toEqual(['A0', 'A1', 'cue', 'B0'])
  })

  it('gives up on a reply whose next chunk never arrives, and moves on', async () => {
    const { player, log } = recordingPlayer()
    const q = createSpeechQueue(player, { stallMs: 5000 })
    q.enqueue({ utterance: 'A', clip: clip('A0'), last: false })
    q.enqueue({ utterance: 'B', clip: clip('B0'), last: true })
    await vi.advanceTimersByTimeAsync(5200)
    q.enqueue({ utterance: 'A', clip: clip('A1-late'), last: true }) // after giving up: dropped
    await vi.runAllTimersAsync()
    expect(log).toEqual(['A0', 'B0'])
  })

  it('puts an ack ahead of waiting replies without interrupting the one playing', async () => {
    const { player, log } = recordingPlayer()
    const q = createSpeechQueue(player)
    q.enqueue({ utterance: 'A', clip: clip('A0'), last: true })
    q.enqueue({ utterance: 'B', clip: clip('B0'), last: true })
    q.enqueue({ utterance: 'ack', clip: clip('ack'), last: true, priority: true })
    await vi.runAllTimersAsync()
    expect(log).toEqual(['A0', 'cue', 'ack', 'cue', 'B0'])
  })

  it('sounds no cue before a reply that starts after a quiet gap', async () => {
    const { player, log } = recordingPlayer()
    const q = createSpeechQueue(player, { cueWithinMs: 3000 })
    q.enqueue({ utterance: 'A', clip: clip('A0'), last: true })
    await vi.advanceTimersByTimeAsync(10_000)
    q.enqueue({ utterance: 'B', clip: clip('B0'), last: true })
    await vi.runAllTimersAsync()
    expect(log).toEqual(['A0', 'B0'])
  })

  it('stop() cuts the current clip, drops the queue, and reports inactive', async () => {
    const { player, log } = recordingPlayer()
    const active: boolean[] = []
    const q = createSpeechQueue(player, { onActiveChange: (a) => active.push(a) })
    q.enqueue({ utterance: 'A', clip: clip('A0'), last: false })
    q.enqueue({ utterance: 'B', clip: clip('B0'), last: true })
    await vi.advanceTimersByTimeAsync(50)
    q.stop()
    q.enqueue({ utterance: 'A', clip: clip('A1'), last: true }) // the stopped reply takes no more
    await vi.runAllTimersAsync()

    expect(log).toEqual(['A0', '(stopped)'])
    expect(q.active()).toBe(false)
    expect(active).toEqual([true, false])

    q.enqueue({ utterance: 'C', clip: clip('C0'), last: true }) // a new reply plays again, no cue
    await vi.runAllTimersAsync()
    expect(log).toEqual(['A0', '(stopped)', 'C0'])
  })

  it('a reply queued right after stop() keeps its late chunks once the stopped run unwinds', async () => {
    const { player, log } = recordingPlayer()
    const q = createSpeechQueue(player)
    q.enqueue({ utterance: 'A', clip: clip('A0'), last: false })
    await vi.advanceTimersByTimeAsync(50)
    q.stop()
    q.enqueue({ utterance: 'C', clip: clip('C0'), last: false })
    await vi.advanceTimersByTimeAsync(50) // the stopped run resumes while C0 plays
    q.enqueue({ utterance: 'C', clip: clip('C1'), last: true })
    await vi.advanceTimersByTimeAsync(300)

    expect(log).toEqual(['A0', '(stopped)', 'C0', 'C1'])
    expect(q.active()).toBe(false)
  })
})
