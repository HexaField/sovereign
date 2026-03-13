export function createRecorder(): { start(): void; stop(): Promise<Blob>; cancel(): void } {
  throw new Error('not implemented')
}

export function playAudio(_blob: Blob): Promise<void> {
  throw new Error('not implemented')
}

export function unlockAudio(): void {
  throw new Error('not implemented')
}

export function isAudioUnlocked(): boolean {
  return false
}
