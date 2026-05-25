import { describe, it, expect } from 'vitest'
import { parsePlainText } from './plain-text.js'
import { parseSrt } from './srt.js'
import { parseVtt } from './vtt.js'
import { parseOtter } from './otter.js'
import { parseZoom } from './zoom.js'
import { getParser, getParserForFile, listParsers, supportedFormats } from './index.js'

describe('§8.6.3 Transcript Parsers', () => {
  it('§8.6.3 MUST include a plain text parser that treats entire content as single speaker', () => {
    const result = parsePlainText('Hello world\nThis is a meeting transcript.')
    expect(result.text).toBe('Hello world\nThis is a meeting transcript.')
    expect(result.segments).toHaveLength(1)
    expect(result.speakers).toEqual({})
  })

  it('§8.6.3 MUST include SRT parser that parses timestamps and text', () => {
    const srt = `1
00:00:01,000 --> 00:00:05,000
Hello everyone

2
00:00:06,000 --> 00:00:10,000
Welcome to the meeting`

    const result = parseSrt(srt)
    expect(result.segments).toHaveLength(2)
    const seg0 = result.segments[0] as { start: number; end: number; text: string }
    expect(seg0.start).toBe(1)
    expect(seg0.end).toBe(5)
    expect(seg0.text).toBe('Hello everyone')
    expect(result.text).toContain('Hello everyone')
  })

  it('§8.6.3 MUST include VTT parser that parses timestamps and text', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
Hello everyone

00:00:06.000 --> 00:00:10.000
Welcome to the meeting`

    const result = parseVtt(vtt)
    expect(result.segments).toHaveLength(2)
    const seg0 = result.segments[0] as { start: number; end: number; text: string }
    expect(seg0.start).toBe(1)
    expect(seg0.end).toBe(5)
    expect(seg0.text).toBe('Hello everyone')
  })

  it('§8.6.3 MUST extract speaker labels from SRT format [Speaker Name]: text', () => {
    const srt = `1
00:00:01,000 --> 00:00:05,000
[Alice]: Hello everyone

2
00:00:06,000 --> 00:00:10,000
[Bob]: Hi Alice`

    const result = parseSrt(srt)
    expect(result.segments).toHaveLength(2)
    const seg0 = result.segments[0] as { speaker: string; text: string }
    expect(seg0.speaker).toBe('Alice')
    expect(seg0.text).toBe('Hello everyone')
    expect(result.speakers).toHaveProperty('Alice')
    expect(result.speakers).toHaveProperty('Bob')
  })

  it('§8.6.3 MUST extract speaker labels from VTT format <v Speaker Name>text', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
<v Alice>Hello everyone

00:00:06.000 --> 00:00:10.000
<v Bob>Hi Alice`

    const result = parseVtt(vtt)
    expect(result.segments).toHaveLength(2)
    const seg0 = result.segments[0] as { speaker: string; text: string }
    expect(seg0.speaker).toBe('Alice')
    expect(seg0.text).toBe('Hello everyone')
    expect(result.speakers).toHaveProperty('Alice')
    expect(result.speakers).toHaveProperty('Bob')
  })

  it('§8.6.3 MUST include Otter.ai JSON parser for { speakers, transcript } format', () => {
    const otterJson = JSON.stringify({
      speakers: ['Alice', 'Bob'],
      transcript: [
        { speaker: 0, text: 'Hello everyone', start: 1, end: 5 },
        { speaker: 1, text: 'Hi Alice', start: 6, end: 10 }
      ]
    })

    const result = parseOtter(otterJson)
    expect(result.segments).toHaveLength(2)
    const seg0 = result.segments[0] as { speaker: string; text: string }
    expect(seg0.speaker).toBe('Alice')
    expect(seg0.text).toBe('Hello everyone')
    expect(result.speakers).toHaveProperty('Alice')
    expect(result.speakers).toHaveProperty('Bob')
  })

  it('§8.6.3 MUST include Zoom transcript parser for transcript.vtt format', () => {
    const zoomVtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
Alice: Hello everyone

00:00:06.000 --> 00:00:10.000
Bob: Hi Alice`

    const result = parseZoom(zoomVtt)
    expect(result.segments).toHaveLength(2)
    const seg0 = result.segments[0] as { speaker: string; text: string }
    expect(seg0.speaker).toBe('Alice')
    expect(seg0.text).toBe('Hello everyone')
    expect(result.speakers).toHaveProperty('Alice')
  })

  it('§8.6.3 MUST be pluggable — new formats addable without modifying import handler', () => {
    const allParsers = listParsers()
    expect(allParsers.length).toBeGreaterThanOrEqual(5)
    // Each parser has the same interface
    for (const p of allParsers) {
      expect(p).toHaveProperty('name')
      expect(p).toHaveProperty('extensions')
      expect(p).toHaveProperty('parse')
      expect(typeof p.parse).toBe('function')
    }
  })

  it('§8.6.3 MUST reject unrecognized formats with 400 and descriptive error listing supported formats', () => {
    const parser = getParser('xlsx')
    expect(parser).toBeNull()
    const fileParser = getParserForFile('unknown.xlsx')
    expect(fileParser).toBeNull()
    // Supported formats available for error messages
    const formats = supportedFormats()
    expect(formats).toContain('.txt')
    expect(formats).toContain('.srt')
    expect(formats).toContain('.vtt')
    expect(formats).toContain('.json')
  })
})
