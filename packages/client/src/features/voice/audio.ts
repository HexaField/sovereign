let _unlocked = false

export function createRecorder(): { start(): void; stop(): Promise<Blob>; cancel(): void } {
  let mediaRecorder: any = null
  let chunks: Blob[] = []
  let stream: any = null

  return {
    start() {
      // Actual implementation requires getUserMedia; this is the structural API
      // In production, call navigator.mediaDevices.getUserMedia({ audio: true })
      // and create MediaRecorder with audio/webm;codecs=opus fallback to audio/webm
      throw new Error('start() requires browser MediaRecorder — use in browser context')
    },
    async stop(): Promise<Blob> {
      if (!mediaRecorder) throw new Error('Not recording')
      return new Promise((resolve) => {
        mediaRecorder.onstop = () => {
          const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' })
          if (stream) stream.getTracks().forEach((t: any) => t.stop())
          resolve(blob)
        }
        mediaRecorder.stop()
      })
    },
    cancel() {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop()
      }
      if (stream) stream.getTracks().forEach((t: any) => t.stop())
      chunks = []
      mediaRecorder = null
      stream = null
    }
  }
}

export interface AudioPlayback {
  cancel(): void
  done: Promise<void>
}

export function playAudio(blob: Blob): AudioPlayback {
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  let resolveDone: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  audio.onended = () => {
    URL.revokeObjectURL(url)
    resolveDone()
  }
  audio.onerror = () => {
    URL.revokeObjectURL(url)
    resolveDone()
  }
  audio.play()

  return {
    cancel() {
      audio.pause()
      audio.currentTime = 0
      URL.revokeObjectURL(url)
      resolveDone()
    },
    done
  }
}

export function unlockAudio(): void {
  if (_unlocked) return
  _unlocked = true
  try {
    const AudioCtx = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const buffer = ctx.createBuffer(1, 1, 22050)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start(0)
    ctx.close?.()
  } catch {
    // Silently fail in non-browser environments
  }
}

export function isAudioUnlocked(): boolean {
  return _unlocked
}

/** @internal — for testing */
export function _resetUnlocked(): void {
  _unlocked = false
}
