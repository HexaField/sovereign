import { describe, expect, it } from 'vitest'
import { createEdgeHygiene } from '../hygiene.js'
import { createMemoryFiles } from '../memory-files.js'
import { link } from '../structure/fixtures.js'
import { shopFiles, shopNodes } from './fixtures.js'
import { conceptChecks, conceptDependencies, conceptMapReport, createConceptMap } from './map.js'
import { readConceptTree, type ConceptTree } from './tree.js'

const shopTree = async (files = shopFiles()): Promise<ConceptTree> => (await readConceptTree(createMemoryFiles(files)))!
const node = (qualifiedName: string) => shopNodes().find((n) => n.qualifiedName === qualifiedName)!

describe('createConceptMap', () => {
  it('gives each file to the deepest page whose claims cover it (D7)', async () => {
    const map = createConceptMap(await shopTree(), shopNodes())
    expect(map.pageOfFile('src/orders/model.ts')).toBe('orders') // a file claim and a directory claim, one page
    expect(map.pageOfFile('src/orders/checkout.ts')).toBe('orders/checkout') // deeper than billing, which claims it too
    expect(map.pageOfFile('src/billing/invoice.ts')).toBe('billing')
    expect(map.pageOfFile('src/util/log.ts')).toBe('') // only the root's src/ covers it
    expect(map.pageOfFile('scripts/build.ts')).toBeUndefined()
  })

  it('lets a symbol a page names stay with that page, and what it holds with it', async () => {
    const map = createConceptMap(await shopTree(), shopNodes())
    expect(map.pageOf(node('Checkout'))).toBe('orders/checkout')
    // Billing names Checkout::finish in a file Checkout owns: a symbol claim beats a file claim
    expect(map.pageOf(node('Checkout::finish'))).toBe('billing')
    expect(map.pageOf(node('step'))).toBe('billing') // inside finish
    expect(map.pageOf(node('Checkout::start'))).toBe('orders/checkout')
    expect(map.pageOf(node('helper'))).toBe('orders') // named by no page: its file's
    expect(map.pageOf(node('log'))).toBe('')
    expect(map.pageOf(node('scripts/build.ts'))).toBeUndefined()
  })

  it('resolves names in their bullet scope first, else when one symbol has the name', async () => {
    const map = createConceptMap(await shopTree(), shopNodes())
    expect(map.symbols.get('orders')!.map((n) => n.qualifiedName)).toEqual([
      'Order',
      'OrderLine',
      'Order::total',
      'Order::lines'
    ])
    expect(map.symbols.get('billing')!.map((n) => n.qualifiedName)).toEqual(['Invoice', 'Checkout::finish'])
    expect(map.unresolved.get('billing')).toEqual(['Refund'])
    expect(map.unresolved.get('orders')).toEqual([])
  })

  it('gives a symbol two unrelated pages name to the deeper one', async () => {
    const files = shopFiles()
    files['mental-models/orders/checkout.md'] = files['mental-models/orders/checkout.md'].replace(
      '`Checkout::start`',
      '`Checkout::start`, `Checkout::finish`'
    )
    const map = createConceptMap(await shopTree(files), shopNodes())
    expect(map.pageOf(node('Checkout::finish'))).toBe('orders/checkout')
    expect(map.symbols.get('billing')!.map((n) => n.qualifiedName)).toEqual(['Invoice'])
  })
})

describe('conceptChecks', () => {
  it('reports coverage by directory, stale links and claims shared by unrelated pages', async () => {
    const tree = await shopTree()
    const map = createConceptMap(tree, shopNodes())
    expect(conceptChecks(map, shopNodes())).toEqual({
      coverage: { files: 6, covered: 4, uncovered: [{ dir: 'scripts', files: 2 }] },
      stale: [{ page: 'orders/checkout', path: 'src/orders/gone.ts' }],
      // The root and Orders also claim checkout.ts, but each is an ancestor of Checkout: no conflict
      shared: [{ path: 'src/orders/checkout.ts', pages: ['orders/checkout', 'billing'], files: 1 }]
    })
  })

  it('groups shared files by their claiming pages, under the files’ common directory', async () => {
    const files = shopFiles()
    files['mental-models/billing.md'] = files['mental-models/billing.md'].replace(
      '[checkout.ts](../src/orders/checkout.ts)',
      '[orders](../src/orders/)'
    )
    const nodes = [...shopNodes(), { ...node('src/orders/model.ts'), id: 'f2', filePath: 'src/orders/lines/x.ts' }]
    const map = createConceptMap(await shopTree(files), nodes)
    expect(conceptChecks(map, nodes).shared).toEqual([
      // model.ts and lines/x.ts: one pair of pages, so one finding under their common directory
      { path: 'src/orders', pages: ['billing', 'orders'], files: 2 },
      { path: 'src/orders/checkout.ts', pages: ['orders/checkout', 'billing'], files: 1 }
    ])
  })
})

describe('conceptDependencies', () => {
  it('lifts trusted code edges to page pairs, leaving out edges inside a page and from unmapped code', async () => {
    const nodes = shopNodes()
    const map = createConceptMap(await shopTree(), nodes)
    const edges = [
      link(node('Checkout::start'), node('Order::total')),
      link(node('Checkout::start'), node('Order::lines')),
      link(node('Invoice'), node('log')),
      link(node('Order'), node('helper')), // inside Orders
      link(node('scripts/build.ts'), node('Order')), // unmapped source
      link(node('Checkout::finish'), node('Invoice'), 'calls', { metadata: { confidence: 0.3 } }) // a guess
    ]
    expect(conceptDependencies(map, nodes, edges, createEdgeHygiene(nodes))).toEqual([
      { from: 'orders/checkout', to: 'orders', edges: 2 },
      { from: 'billing', to: '', edges: 1 }
    ])
  })
})

describe('conceptMapReport', () => {
  it('lists every page with its counts, then the checks and dependencies', async () => {
    const nodes = shopNodes()
    const map = createConceptMap(await shopTree(), nodes)
    const report = conceptMapReport(map, nodes, [], createEdgeHygiene(nodes))
    expect(report.dir).toBe('mental-models')
    expect(report.pages.map((p) => [p.id, p.files, p.symbols, p.unresolved, p.flows])).toEqual([
      ['', 1, 0, [], 0],
      ['orders', 1, 4, [], 1],
      ['orders/checkout', 1, 2, [], 0],
      ['billing', 1, 2, ['Refund'], 0]
    ])
    expect(report.pages[1]).toMatchObject({
      title: 'Orders',
      parent: '',
      children: ['orders/checkout'],
      file: 'mental-models/orders/README.md'
    })
    expect(report.coverage.covered).toBe(4)
    expect(report.dependencies).toEqual([])
  })
})
