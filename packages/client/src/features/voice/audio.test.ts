import { describe, it } from 'vitest'

describe('§6.2 Audio Utilities', () => {
  it.todo('createRecorder MUST manage MediaRecorder lifecycle')
  it.todo('createRecorder MUST use audio/webm;codecs=opus with fallback to audio/webm')
  it.todo('createRecorder MUST collect data chunks and return single Blob on stop')
  it.todo('playAudio MUST play an audio blob through default audio output')
  it.todo('playAudio MUST resolve when playback completes')
  it.todo('playAudio MUST support interruption (returns cancel function)')
  it.todo('unlockAudio MUST create and play a silent audio buffer for iOS Safari')
  it.todo('unlockAudio MUST be called on a user gesture event')
  it.todo('unlockAudio MUST be called only once')
  it.todo('isAudioUnlocked MUST return whether audio playback has been unlocked')
})
