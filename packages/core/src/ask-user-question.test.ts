import { describe, it, expect } from 'vitest'
import {
  isAskUserQuestionToolName,
  parseAskUserQuestionResult,
  type AskUserQuestionResult
} from './ask-user-question.js'

describe('ask-user-question helpers', () => {
  describe('isAskUserQuestionToolName', () => {
    it('matches the exact SDK tool name', () => {
      expect(isAskUserQuestionToolName('AskUserQuestion')).toBe(true)
    })
    it('does not match variants or unrelated tools', () => {
      expect(isAskUserQuestionToolName('ask_user_question')).toBe(false)
      expect(isAskUserQuestionToolName('AskUserQuestions')).toBe(false)
      expect(isAskUserQuestionToolName('Bash')).toBe(false)
      expect(isAskUserQuestionToolName(undefined)).toBe(false)
      expect(isAskUserQuestionToolName('')).toBe(false)
    })
  })

  describe('parseAskUserQuestionResult', () => {
    it('returns null for undefined / empty / non-JSON content', () => {
      expect(parseAskUserQuestionResult(undefined)).toBeNull()
      expect(parseAskUserQuestionResult('')).toBeNull()
      expect(parseAskUserQuestionResult('Answer questions?')).toBeNull()
      expect(parseAskUserQuestionResult('not json')).toBeNull()
      expect(parseAskUserQuestionResult('{ malformed')).toBeNull()
    })

    it('returns null for JSON without our discriminator kind', () => {
      expect(parseAskUserQuestionResult(JSON.stringify({ answers: {} }))).toBeNull()
      expect(parseAskUserQuestionResult(JSON.stringify({ kind: 'other' }))).toBeNull()
    })

    it('returns null when required fields are missing', () => {
      const raw = JSON.stringify({ kind: 'sovereign:ask-user-question', answers: {} })
      expect(parseAskUserQuestionResult(raw)).toBeNull()
    })

    it('parses a well-formed answer payload back into structured form', () => {
      const result: AskUserQuestionResult = {
        kind: 'sovereign:ask-user-question',
        questions: [
          {
            question: 'Which library?',
            header: 'Library',
            multiSelect: false,
            options: [
              { label: 'date-fns', description: 'Modern' },
              { label: 'luxon', description: 'Immutable' }
            ]
          }
        ],
        answers: { 'Which library?': 'date-fns' },
        annotations: { 'Which library?': { custom: false } },
        answeredAt: 1_710_000_000_000
      }
      const parsed = parseAskUserQuestionResult(JSON.stringify(result))
      expect(parsed).toEqual(result)
    })

    it('tolerates optional annotations being absent', () => {
      const raw = JSON.stringify({
        kind: 'sovereign:ask-user-question',
        questions: [],
        answers: {},
        answeredAt: 0
      })
      const parsed = parseAskUserQuestionResult(raw)
      expect(parsed?.kind).toBe('sovereign:ask-user-question')
      expect(parsed?.annotations).toBeUndefined()
    })
  })
})
