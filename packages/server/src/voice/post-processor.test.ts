import { describe, it, expect } from 'vitest'
import { createRuleBasedPostProcessor } from './post-processor.js'
import type { VoicePostProcessor } from './post-processor.js'

describe('§8.5.2.1 TTS Post-Processing (Rule-Based)', () => {
  let processor: VoicePostProcessor

  it('§8.5.2.1 MUST define VoicePostProcessor interface', () => {
    processor = createRuleBasedPostProcessor()
    expect(processor).toBeDefined()
    expect(typeof processor.process).toBe('function')
  })

  it('§8.5.2.1 MUST implement rule-based fallback post-processor', async () => {
    processor = createRuleBasedPostProcessor()
    const result = await processor.process('Hello world')
    expect(result).toBe('Hello world')
  })

  it('§8.5.2.1 MUST strip Markdown formatting (bold, italic, headers, links)', async () => {
    processor = createRuleBasedPostProcessor()
    const input = '# Title\n\n**bold text** and *italic text* and [a link](https://example.com)'
    const result = await processor.process(input)
    expect(result).not.toContain('#')
    expect(result).not.toContain('**')
    expect(result).not.toContain('*')
    expect(result).toContain('bold text')
    expect(result).toContain('italic text')
    expect(result).toContain('a link')
  })

  it('§8.5.2.1 MUST replace URLs with "a link" or "a link to [domain]"', async () => {
    processor = createRuleBasedPostProcessor()
    const result = await processor.process('Visit https://github.com/repo/issues for details')
    expect(result).toContain('a link to github.com')
    expect(result).not.toContain('https://')
  })

  it('§8.5.2.1 MUST replace file paths with "a file called [basename]"', async () => {
    processor = createRuleBasedPostProcessor()
    const result = await processor.process('Check /Users/josh/projects/server/index.ts for the issue')
    expect(result).toContain('a file called index.ts')
    expect(result).not.toContain('/Users/')
  })

  it('§8.5.2.1 MUST omit code blocks and replace with "some code" or "a code snippet"', async () => {
    processor = createRuleBasedPostProcessor()
    const input = 'Here is the fix:\n\n```typescript\nconst x = 1;\nconsole.log(x);\n```\n\nThat should work.'
    const result = await processor.process(input)
    expect(result).toContain('a code snippet')
    expect(result).not.toContain('const x')
    expect(result).toContain('That should work')
  })

  it('§8.5.2.1 MUST omit tables and replace with brief description', async () => {
    processor = createRuleBasedPostProcessor()
    const input = 'Results:\n\n| Name | Score |\n| --- | --- |\n| Alice | 95 |\n| Bob | 87 |\n| Carol | 92 |'
    const result = await processor.process(input)
    expect(result).toContain('a table with')
    expect(result).toContain('row')
    expect(result).not.toContain('Alice')
  })

  it('§8.5.2.1 MUST collapse excessive whitespace and list markers', async () => {
    processor = createRuleBasedPostProcessor()
    const input = '- Item one\n- Item two\n- Item three\n\n\n\nNext section'
    const result = await processor.process(input)
    expect(result).not.toContain('- ')
    expect(result).not.toMatch(/\n{3,}/)
    expect(result).toContain('Item one')
    expect(result).toContain('Next section')
  })

  it('§8.5.2.1 MUST work without any LLM dependency', async () => {
    processor = createRuleBasedPostProcessor()
    // Process should be synchronous internally (async wrapper only)
    // and should not require any external service
    const result = await processor.process('Simple text')
    expect(result).toBe('Simple text')
  })

  it('handles combined complex input', async () => {
    processor = createRuleBasedPostProcessor()
    const input = [
      '## Build Results',
      '',
      'The build at https://ci.example.com/builds/123 failed.',
      '',
      '```bash',
      'npm run build',
      'ERROR: Module not found',
      '```',
      '',
      'Check /home/user/project/src/index.ts for the missing import.',
      '',
      '| File | Status |',
      '| --- | --- |',
      '| index.ts | Failed |',
      '',
      '- Fix the import',
      '- Run tests',
      '- Deploy'
    ].join('\n')

    const result = await processor.process(input)
    expect(result).toContain('Build Results')
    expect(result).toContain('a link to ci.example.com')
    expect(result).toContain('a code snippet')
    expect(result).toContain('a file called index.ts')
    expect(result).toContain('a table with')
    expect(result).not.toContain('```')
    expect(result).not.toContain('##')
  })
})
