// Speech queue — plays whole replies one after another, never cutting one
// off for another. A reply (utterance) arrives as one clip or as streamed
// chunks; its chunks play in order, and the queue waits for late chunks
// rather than jumping to the next reply. A short cue sounds between
// back-to-back replies. An acknowledgement or a "Play aloud" request goes
// ahead of replies still waiting, but never interrupts the one playing.
// Only stop() cuts playback short.
//
// Pure scheduling: the player (decode + play a clip, play the cue, stop)
// is injected, so the queue runs the same under Web Audio and in tests.

export interface SpeechPlayer {
  /** Play one clip; resolve when it finishes or is stopped. */
  play(clip: ArrayBuffer): Promise<void>
  /** Play the between-replies cue; resolve when it finishes. */
  cue(): Promise<void>
  /** Stop the clip or cue now playing. */
  stop(): void
}

export interface SpeechClip {
  /** The reply this clip belongs to. */
  utterance: string
  clip: ArrayBuffer
  /** The reply's last clip. */
  last: boolean
  /** Ahead of waiting replies (acks, Play aloud). */
  priority?: boolean
}

interface Utterance {
  id: string
  clips: ArrayBuffer[]
  done: boolean
  priority: boolean
  /** Resolves a waiter when a clip arrives or the reply ends. */
  wake: (() => void) | null
}

export interface SpeechQueueOptions {
  /** Give up on a reply whose next chunk has not arrived after this long. */
  stallMs?: number
  /** Sound the cue when the previous reply ended less than this long ago. */
  cueWithinMs?: number
  now?: () => number
  onActiveChange?: (active: boolean) => void
}

export function createSpeechQueue(player: SpeechPlayer, options: SpeechQueueOptions = {}) {
  const stallMs = options.stallMs ?? 20_000
  const cueWithinMs = options.cueWithinMs ?? 3_000
  const now = options.now ?? (() => Date.now())

  const queue: Utterance[] = []
  let current: Utterance | null = null
  /** Replies already played or given up on: a late chunk must not restart one. */
  const finished = new Set<string>()
  const finish = (u: Utterance) => {
    u.done = true
    finished.add(u.id)
    if (finished.size > 200) finished.delete(finished.values().next().value!)
  }
  let running = false
  let generation = 0
  /** When speech last finished playing: a reply starting soon after gets the cue. */
  let lastEndedAt = -Infinity

  const setActive = (active: boolean) => options.onActiveChange?.(active)

  function find(id: string): Utterance | undefined {
    return current?.id === id ? current : queue.find((u) => u.id === id)
  }

  function enqueue(item: SpeechClip): void {
    if (finished.has(item.utterance)) return
    let u = find(item.utterance)
    if (!u) {
      u = { id: item.utterance, clips: [], done: false, priority: !!item.priority, wake: null }
      // Priority goes ahead of replies still waiting, after earlier priority ones.
      const at = u.priority ? queue.findIndex((q) => !q.priority) : -1
      queue.splice(at === -1 ? queue.length : at, 0, u)
    }
    if (u.done) return // a reply already finished (or given up on) takes no more clips
    u.clips.push(item.clip)
    if (item.last) u.done = true
    u.wake?.()
    if (!running) void run()
  }

  /** The next clip of `u`, waiting for late chunks; null when the reply ends. */
  async function nextClip(u: Utterance, gen: number): Promise<ArrayBuffer | null> {
    while (u.clips.length === 0) {
      if (u.done || gen !== generation) return null
      const arrived = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), stallMs)
        u.wake = () => {
          clearTimeout(timer)
          resolve(true)
        }
      })
      u.wake = null
      if (!arrived) return null // stalled: give up on the rest of this reply
    }
    return u.clips.shift() ?? null
  }

  async function run(): Promise<void> {
    running = true
    setActive(true)
    const gen = generation
    while (gen === generation && queue.length > 0) {
      const u = queue.shift()!
      current = u
      let started = false
      for (let clip = await nextClip(u, gen); clip && gen === generation; clip = await nextClip(u, gen)) {
        if (!started) {
          started = true
          if (now() - lastEndedAt < cueWithinMs) await player.cue()
          if (gen !== generation) break
        }
        await player.play(clip)
        if (gen === generation) lastEndedAt = now()
      }
      finish(u)
      // After stop(), a newer run may own `current` already.
      if (current === u) current = null
    }
    if (gen === generation) {
      running = false
      setActive(false)
    }
  }

  return {
    enqueue,
    /** Stop playback now and drop every queued reply. */
    stop(): void {
      generation++
      for (const u of [current, ...queue]) {
        if (!u) continue
        finish(u)
        u.wake?.()
      }
      queue.length = 0
      current = null
      running = false
      lastEndedAt = -Infinity
      player.stop()
      setActive(false)
    },
    /** Whether anything plays or waits to play. */
    active(): boolean {
      return running
    }
  }
}

export type SpeechQueue = ReturnType<typeof createSpeechQueue>
