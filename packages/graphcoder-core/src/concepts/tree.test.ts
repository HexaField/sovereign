import { describe, expect, it } from 'vitest'
import { createMemoryFiles } from '../memory-files.js'
import { shopFiles } from './fixtures.js'
import { breadcrumb, conceptDirOf, isAncestor, readConceptTree, symbolNames } from './tree.js'

describe('symbolNames', () => {
  it('expands A::{b, c}, drops calls and generics, reads a dot as ::', () => {
    expect(symbolNames('Session::{open, check}')).toEqual(['Session::open', 'Session::check'])
    expect(symbolNames('Order.total()')).toEqual(['Order::total'])
    expect(symbolNames('Vec<String>')).toEqual(['Vec'])
    expect(symbolNames('ctx.require(&CAPABILITY)')).toEqual(['ctx::require'])
  })

  it('skips file names, paths, flags and anything that is not a name', () => {
    expect(symbolNames('events_ws.rs')).toEqual([])
    expect(symbolNames('src/a.ts')).toEqual([])
    expect(symbolNames('--release')).toEqual([])
    expect(symbolNames('a + b')).toEqual([])
  })
})

describe('readConceptTree', () => {
  it('reads every page in tree order: Parts order first, tree docs left out', async () => {
    const tree = await readConceptTree(createMemoryFiles(shopFiles()), 'mental-models')
    expect(tree?.dir).toBe('mental-models')
    expect(tree?.pages.map((p) => p.id)).toEqual(['', 'orders', 'orders/checkout', 'billing'])
    expect(tree?.pages.map((p) => [p.id, p.parent, p.depth, p.children])).toEqual([
      ['', null, 0, ['orders', 'billing']],
      ['orders', '', 1, ['orders/checkout']],
      ['orders/checkout', 'orders', 2, []],
      ['billing', '', 1, []]
    ])
  })

  it('reads title, model and Why as plain text', async () => {
    const tree = (await readConceptTree(createMemoryFiles(shopFiles())))!
    const [root, orders] = tree.pages
    expect(root).toMatchObject({
      file: 'mental-models/README.md',
      title: 'Shop',
      model: 'The shop takes orders and bills them.',
      why: 'One process keeps the stock and the money in step.'
    })
    expect(orders.model).toBe('An order holds the items a customer buys, until checkout ends it.')
  })

  it('claims the code a page links in "Where in the code", resolved from the page, and says whether it exists', async () => {
    const tree = (await readConceptTree(createMemoryFiles(shopFiles())))!
    const byId = new Map(tree.pages.map((p) => [p.id, p]))
    // The external link and the link to another page are no claims
    expect(byId.get('')!.paths).toEqual([{ path: 'src', kind: 'dir' }])
    expect(byId.get('orders')!.paths).toEqual([
      { path: 'src/orders', kind: 'dir' },
      { path: 'src/orders/model.ts', kind: 'file' }
    ])
    expect(byId.get('orders/checkout')!.paths).toEqual([
      { path: 'src/orders/checkout.ts', kind: 'file' },
      { path: 'src/orders/gone.ts', kind: 'missing' }
    ])
    expect(byId.get('billing')!.paths).toEqual([
      { path: 'src/billing', kind: 'dir' },
      { path: 'src/orders/checkout.ts', kind: 'file' }
    ])
  })

  it('claims backticked symbols, scoped to the paths their bullet links', async () => {
    const tree = (await readConceptTree(createMemoryFiles(shopFiles())))!
    const byId = new Map(tree.pages.map((p) => [p.id, p]))
    expect(byId.get('orders')!.symbols).toEqual([
      { name: 'Order', scope: ['src/orders/model.ts'] },
      { name: 'OrderLine', scope: ['src/orders/model.ts'] },
      // A bullet that runs over two lines is one claim; `shared.ts` is a file name, not a symbol
      { name: 'Order::total', scope: [] },
      { name: 'Order::lines', scope: [] }
    ])
    expect(byId.get('orders/checkout')!.symbols).toEqual([
      { name: 'Checkout', scope: ['src/orders/checkout.ts'] },
      { name: 'Checkout::start', scope: ['src/orders/checkout.ts'] }
    ])
  })

  it('reads "How it works" numbered steps as flows, outside code blocks and tables', async () => {
    const tree = (await readConceptTree(createMemoryFiles(shopFiles())))!
    expect(tree.pages[1].flows).toEqual([
      {
        title: 'Placing an order',
        steps: [
          { text: '`Order::new` opens it (model.ts).', symbols: ['Order::new'] },
          { text: '`Checkout::start` takes the payment.', symbols: ['Checkout::start'] }
        ]
      }
    ])
    expect(tree.pages[0].flows).toEqual([])
  })

  it('hangs a page whose folder has no README on its nearest ancestor page', async () => {
    const files = { ...shopFiles(), 'mental-models/misc/notes.md': '# Notes\n\nLoose notes.\n' }
    const tree = (await readConceptTree(createMemoryFiles(files)))!
    const notes = tree.pages.find((p) => p.id === 'misc/notes')!
    expect([notes.parent, notes.depth]).toEqual(['', 2])
    expect(tree.pages[0].children).toEqual(['orders', 'billing', 'misc/notes'])
  })

  it('is null without a tree', async () => {
    expect(await readConceptTree(createMemoryFiles({ 'src/a.ts': '' }))).toBeNull()
    expect(await readConceptTree(createMemoryFiles({ 'mental-models/CONVENTIONS.md': '# x' }))).toBeNull()
  })
})

describe('tree helpers', () => {
  it('tells ancestors apart from relatives', () => {
    expect(isAncestor('', 'orders')).toBe(true)
    expect(isAncestor('orders', 'orders/checkout')).toBe(true)
    expect(isAncestor('orders', 'orders')).toBe(false)
    expect(isAncestor('orders', 'ordersx/a')).toBe(false)
    expect(isAncestor('billing', 'orders')).toBe(false)
  })

  it('names a page by its ancestors, root left out', async () => {
    const tree = (await readConceptTree(createMemoryFiles(shopFiles())))!
    expect(breadcrumb(tree, 'orders/checkout')).toBe('Orders › Checkout')
    expect(breadcrumb(tree, '')).toBe('Shop')
  })
})

describe('conceptDirOf', () => {
  it('reads the folder from .graphcoder/config.json, else mental-models', async () => {
    expect(await conceptDirOf(createMemoryFiles({}))).toBe('mental-models')
    expect(
      await conceptDirOf(createMemoryFiles({ '.graphcoder/config.json': '{"conceptDir": "docs/concepts/"}' }))
    ).toBe('docs/concepts')
  })

  it('refuses a folder outside the repo, and a file it cannot read', async () => {
    await expect(
      conceptDirOf(createMemoryFiles({ '.graphcoder/config.json': '{"conceptDir": "../x"}' }))
    ).rejects.toThrow(/conceptDir/)
    await expect(conceptDirOf(createMemoryFiles({ '.graphcoder/config.json': '{' }))).rejects.toThrow(/config\.json/)
  })
})
