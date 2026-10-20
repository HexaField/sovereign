import { describe, expect, it } from 'vitest'
import type { TestRef } from '../contract.js'
import { createMemoryFiles } from '../memory-files.js'
import { changed, fileNode, sym } from '../structure/fixtures.js'
import { shopFiles, shopNodes } from './fixtures.js'
import { conceptImpact } from './impact.js'
import { createConceptMap } from './map.js'
import { readConceptTree } from './tree.js'

const REFUNDS_PAGE = `# Refunds

A refund returns a payment.

<details><summary>Where in the code</summary>

- [refund.ts](../../src/orders/refund.ts): \`Refund\`.

</details>
`

/*
 * The change: Checkout's model is rewritten (no code under it changes), Billing's page goes (and Invoice::void with
 * it), a Refunds page arrives with its code, and log and Invoice change with no page edit.
 */
async function shopChange() {
  const baseFiles = shopFiles()
  const headFiles: Record<string, string> = {
    ...shopFiles(),
    'mental-models/orders/refunds.md': REFUNDS_PAGE,
    'src/orders/refund.ts': ''
  }
  delete headFiles['mental-models/billing.md']
  headFiles['mental-models/orders/checkout.md'] = headFiles['mental-models/orders/checkout.md'].replace(
    'Checkout ends an order: it takes the payment and closes the order.',
    'Checkout ends an order and sends its invoice.'
  )
  const voidMethod = sym('method', 'void', 'src/billing/invoice.ts', [20, 25], { qualifiedName: 'Invoice::void' })
  const refund = sym('class', 'Refund', 'src/orders/refund.ts', [1, 10])
  const baseNodes = [...shopNodes(), voidMethod]
  const headNodes = [...shopNodes(), fileNode('src/orders/refund.ts', 10), refund]
  const base = createConceptMap((await readConceptTree(createMemoryFiles(baseFiles)))!, baseNodes)
  const head = createConceptMap((await readConceptTree(createMemoryFiles(headFiles)))!, headNodes)
  const at = (nodes: typeof baseNodes, q: string) => nodes.find((n) => n.qualifiedName === q)!
  const files = [
    changed('mental-models/orders/checkout.md', [[3, 1, 3, 1]]),
    changed('mental-models/billing.md', [[1, 20, 0, 0]], { status: 'deleted' }),
    changed('mental-models/orders/refunds.md', [[0, 0, 1, 10]], { status: 'added' }),
    changed('src/orders/refund.ts', [[0, 0, 1, 10]], { status: 'added' }),
    changed('src/util/log.ts', [[1, 1, 1, 1]]),
    changed('src/billing/invoice.ts', [[20, 6, 19, 0]])
  ]
  const changes = {
    added: [refund],
    removed: [voidMethod],
    modified: [
      { base: at(baseNodes, 'log'), head: at(headNodes, 'log') },
      { base: at(baseNodes, 'Invoice'), head: at(headNodes, 'Invoice') }
    ]
  }
  const testsReaching = (ids: string[]): TestRef[] =>
    ids.map((id) => ({ id: `test of ${id}`, file: 't.test.ts', depth: 1 }))
  return { base, head, files, changes, testsReaching, refund }
}

describe('conceptImpact', () => {
  it('lists the touched pages with their ancestors, parents first, removed pages under their old parent', async () => {
    const c = await shopChange()
    const impact = conceptImpact(c)!
    expect(impact.dir).toBe('mental-models')
    expect(impact.pages.map((p) => [p.id, p.page, p.signal])).toEqual([
      ['', undefined, 'stale-page'],
      ['orders', undefined, undefined],
      ['orders/checkout', 'changed', 'docs-only'],
      ['orders/refunds', 'added', undefined],
      ['billing', 'removed', undefined]
    ])
  })

  it('places changed symbols through each side’s map: head for added and modified, base for removed', async () => {
    const c = await shopChange()
    const byId = new Map(conceptImpact(c)!.pages.map((p) => [p.id, p]))
    // Billing's page is gone on head, so Invoice falls to the root's src/ claim there
    expect(byId.get('')).toMatchObject({
      symbols: { added: 0, removed: 0, modified: 2 },
      files: ['src/billing/invoice.ts', 'src/util/log.ts']
    })
    expect(byId.get('billing')).toMatchObject({
      symbols: { added: 0, removed: 1, modified: 0 },
      files: ['src/billing/invoice.ts'],
      tests: [],
      title: 'Billing',
      file: 'mental-models/billing.md'
    })
    expect(byId.get('orders/refunds')).toMatchObject({
      symbols: { added: 1, removed: 0, modified: 0 },
      tests: [`test of ${c.refund.id}`],
      parent: 'orders',
      depth: 2,
      model: 'A refund returns a payment.'
    })
    expect(byId.get('orders')).toMatchObject({ symbols: { added: 0, removed: 0, modified: 0 }, files: [], tests: [] })
  })

  it('keeps the text before an edit of the title, model or Why', async () => {
    const c = await shopChange()
    const checkout = conceptImpact(c)!.pages.find((p) => p.id === 'orders/checkout')!
    expect(checkout.model).toBe('Checkout ends an order and sends its invoice.')
    expect(checkout.before).toEqual({
      title: 'Checkout',
      model: 'Checkout ends an order: it takes the payment and closes the order.',
      why: 'Payment and closing happen together.'
    })
  })

  it('sums it up in one line: shifted concepts by their top two levels, then code-only ones', async () => {
    const c = await shopChange()
    expect(conceptImpact(c)!.summary).toBe(
      'Shifts Billing (1 removed), Orders › Checkout (1 changed), Orders › Refunds (1 new); touches Shop (code only)'
    )
    const files = [...c.files, changed('mental-models/orders/README.md', [[3, 1, 3, 1]])]
    const changes = { ...c.changes, removed: [] }
    expect(conceptImpact({ ...c, files, changes })!.summary).toBe(
      'Shifts Billing (1 removed), Orders (1 changed), Orders › Checkout (1 changed) and 1 more; touches Shop (code only)'
    )
  })

  it('does not call a parent page docs-only when code under its children changed', async () => {
    const c = await shopChange()
    const files = [...c.files, changed('mental-models/orders/README.md', [[3, 1, 3, 1]])]
    const orders = conceptImpact({ ...c, files })!.pages[1]
    expect([orders.id, orders.page, orders.signal]).toEqual(['orders', 'changed', undefined])
  })

  it('is undefined when neither side has a tree, and empty when the change touches no concept', async () => {
    const c = await shopChange()
    expect(conceptImpact({ ...c, base: undefined, head: undefined })).toBeUndefined()
    const none = conceptImpact({ ...c, files: [], changes: { added: [], removed: [], modified: [] } })
    expect(none).toEqual({ dir: 'mental-models', summary: '', pages: [] })
  })
})
