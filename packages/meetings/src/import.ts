// External meeting import — §8.6

import type { EventBus } from '@sovereign/core'
import type { MeetingsService, Meeting } from './meetings.js'
import { getParserForFile, supportedFormats, type ParsedTranscript } from './parsers/index.js'

export interface ImportRequest {
  title: string
  threadKey?: string
  platform?: string
  startedAt?: string
  tags?: string[]
  transcriptFilename?: string
  transcriptContent?: string | Buffer
  audioFilename?: string
  audioBuffer?: Buffer
  audioMimeType?: string
}

export interface ImportResult {
  meeting: Meeting
  transcriptParsed: boolean
  summarizationTriggered: boolean
}

export interface ImportHandler {
  import(orgId: string, req: ImportRequest): Promise<ImportResult>
}

export function createImportHandler(deps: {
  bus: EventBus
  meetings: MeetingsService
  onAudioImport?: (meetingId: string, orgId: string, buffer: Buffer, mimeType: string) => Promise<void>
}): ImportHandler {
  const { bus, meetings, onAudioImport } = deps

  return {
    async import(orgId: string, req: ImportRequest): Promise<ImportResult> {
      if (!req.title) throw Object.assign(new Error('title is required'), { status: 400 })
      if (!req.transcriptContent && !req.audioBuffer) {
        throw Object.assign(new Error('At least one of audio or transcript file is required'), { status: 400 })
      }

      let transcript: Meeting['transcript'] = undefined
      let parsed: ParsedTranscript | undefined

      // Parse transcript if provided
      if (req.transcriptContent && req.transcriptFilename) {
        const parser = getParserForFile(req.transcriptFilename)
        if (!parser) {
          throw Object.assign(new Error(`Unsupported transcript format. Supported: ${supportedFormats().join(', ')}`), {
            status: 400
          })
        }
        parsed = parser.parse(req.transcriptContent)
        transcript = {
          status: 'completed',
          text: parsed.text,
          segments: parsed.segments,
          speakers: parsed.speakers,
          completedAt: new Date().toISOString()
        }
      }

      const meeting = await meetings.create(orgId, {
        title: req.title,
        threadKey: req.threadKey,
        startedAt: req.startedAt,
        source: 'import',
        importMeta: {
          platform: req.platform,
          originalFileName: req.transcriptFilename ?? req.audioFilename,
          importedAt: new Date().toISOString()
        },
        transcript: transcript ?? { status: 'none' },
        tags: req.tags
      })

      let summarizationTriggered = false

      // Handle audio
      if (req.audioBuffer && onAudioImport) {
        if (!parsed) {
          // Audio only — trigger transcription pipeline
          await onAudioImport(meeting.id, orgId, req.audioBuffer, req.audioMimeType ?? 'audio/webm')
        }
        // If both audio and transcript provided, store audio but skip transcription
      }

      // Trigger summarization if transcript available
      if (parsed) {
        bus.emit({
          type: 'meeting.transcript.completed',
          timestamp: new Date().toISOString(),
          source: 'import',
          payload: { orgId, meetingId: meeting.id, threadKey: req.threadKey }
        })
        summarizationTriggered = true
      }

      return {
        meeting,
        transcriptParsed: !!parsed,
        summarizationTriggered
      }
    }
  }
}
