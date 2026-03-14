import { describe, it } from 'vitest'

describe('§8.6.3 Transcript Parsers', () => {
  it.todo('§8.6.3 MUST include a plain text parser that treats entire content as single speaker')
  it.todo('§8.6.3 MUST include SRT parser that parses timestamps and text')
  it.todo('§8.6.3 MUST include VTT parser that parses timestamps and text')
  it.todo('§8.6.3 MUST extract speaker labels from SRT format [Speaker Name]: text')
  it.todo('§8.6.3 MUST extract speaker labels from VTT format <v Speaker Name>text')
  it.todo('§8.6.3 MUST include Otter.ai JSON parser for { speakers, transcript } format')
  it.todo('§8.6.3 MUST include Zoom transcript parser for transcript.vtt format')
  it.todo('§8.6.3 MUST be pluggable — new formats addable without modifying import handler')
  it.todo('§8.6.3 MUST reject unrecognized formats with 400 and descriptive error listing supported formats')
})
