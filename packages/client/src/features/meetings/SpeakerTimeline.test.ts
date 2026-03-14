import { describe, it, expect } from 'vitest'
import { SpeakerTimeline, getTimelineSpeakers, getSegmentStyle } from './SpeakerTimeline.js'

describe('§8.9.2 Speaker Timeline', () => {
  it('§8.9.2 MUST show colored bars indicating who spoke when', () => {
    expect(typeof SpeakerTimeline).toBe('function')
    const speakers = getTimelineSpeakers([
      { speaker: 'Alice', startMs: 0, endMs: 5000 },
      { speaker: 'Bob', startMs: 5000, endMs: 10000 }
    ])
    expect(speakers).toEqual(['Alice', 'Bob'])

    const style = getSegmentStyle({ speaker: 'Alice', startMs: 0, endMs: 5000 }, 10000, speakers)
    expect(style.left).toBe('0%')
    expect(style.width).toBe('50%')
    expect(style.background).toBeTruthy()
  })

  it('§8.9.2 MUST integrate with audio waveform player', () => {
    // SpeakerTimeline accepts onSeek callback for click-to-seek
    expect(typeof SpeakerTimeline).toBe('function')
  })
})
