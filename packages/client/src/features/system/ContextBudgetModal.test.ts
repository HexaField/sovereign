import { describe, it, expect } from 'vitest'

describe('§P.2 Context Budget Modal', () => {
  it('§P.2 exports ContextBudgetModal component', async () => {
    const mod = await import('./ContextBudgetModal.js')
    expect(typeof mod.ContextBudgetModal).toBe('function')
    expect(typeof mod.default).toBe('function')
  })

  it('§P.2 exports formatNum utility', async () => {
    const { formatNum } = await import('./ContextBudgetModal.js')
    expect(formatNum(1234)).toBe('1,234')
    expect(formatNum(0)).toBe('0')
  })

  it('§P.2 exports estimateTokens utility', async () => {
    const { estimateTokens } = await import('./ContextBudgetModal.js')
    expect(estimateTokens(400)).toBe(100)
    expect(estimateTokens(401)).toBe(101)
  })

  it('§P.2 exports formatSize utility', async () => {
    const { formatSize } = await import('./ContextBudgetModal.js')
    expect(formatSize(4000)).toContain('4,000 chars')
    expect(formatSize(4000)).toContain('1,000 tok')
  })

  it('§P.2 exports pct utility', async () => {
    const { pct } = await import('./ContextBudgetModal.js')
    expect(pct(50, 100)).toBe('50.0%')
    expect(pct(0, 0)).toBe('0%')
    expect(pct(1, 3)).toBe('33.3%')
  })
})
