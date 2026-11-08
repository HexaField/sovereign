// Test fixtures for the concept tests (not exported from the package): a small
// concept tree in the shape of ad4m's mental-models/, over a small code base.

import type { GraphNode } from '../graph.js'
import { fileNode, sym } from '../structure/fixtures.js'

export const ROOT_PAGE = `# Shop

The shop takes **orders** and bills them.

**Why:** One process keeps the stock and the money in step.

**Parent:** none

## Parts
- [Orders](orders/README.md): what a customer buys.
- [Billing](billing.md): what a customer pays.

<details><summary>Where in the code</summary>

- [src/](../src): all of it.
- [The site](https://example.com/shop): not code.

</details>
`

export const ORDERS_PAGE = `# Orders

An **order** holds the items a customer buys,
until checkout ends it.

**Why:** Orders stay open while the customer shops.

**Parent:** [Shop](../README.md)

## Parts
- [Checkout](checkout.md): how an order ends.

<details><summary>How it works</summary>

\`\`\`
cart ──► Order::new ──► checkout:
\`\`\`

Placing an order:
1. \`Order::new\` opens it ([model.ts](../../src/orders/model.ts)).
2. \`Checkout::start\` takes the payment.

| Step | Code |
|---|---|
| 3. Not a step | \`Nope\` |

</details>

<details><summary>Where in the code</summary>

- [src/orders/](../../src/orders/): orders.
- \`Order\`, \`OrderLine\` in [model.ts](../../src/orders/model.ts).
- \`shared.ts\` and \`Order.total()\` are named here,
  continued on a second line: \`Order::{lines, total}\`.

</details>
`

export const CHECKOUT_PAGE = `# Checkout

Checkout ends an order: it takes the payment and closes the order.

**Why:** Payment and closing happen together.

**Parent:** [Orders](README.md)

<details><summary>Where in the code</summary>

- [checkout.ts](../../src/orders/checkout.ts#L10): \`Checkout\`, \`Checkout::start\`.
- [gone.ts](../../src/orders/gone.ts): an old file.

</details>
`

export const BILLING_PAGE = `# Billing

Billing turns a closed order into an **invoice**.

**Why:** Invoices are kept apart from orders.

**Parent:** [Shop](README.md)

<details><summary>Where in the code</summary>

- [src/billing/](../src/billing): invoices, \`Invoice\`, \`Refund\`.
- [checkout.ts](../src/orders/checkout.ts): \`Checkout::finish\` sends the invoice.
- [Glossary](GLOSSARY.md): terms.

</details>
`

/** The repo's files: the concept tree, its tree docs, and the code it describes */
export function shopFiles(): Record<string, string> {
  return {
    'mental-models/README.md': ROOT_PAGE,
    'mental-models/CONVENTIONS.md': '# How the pages are written\n',
    'mental-models/GLOSSARY.md': '# Glossary\n',
    'mental-models/orders/README.md': ORDERS_PAGE,
    'mental-models/orders/checkout.md': CHECKOUT_PAGE,
    'mental-models/billing.md': BILLING_PAGE,
    'src/orders/model.ts': 'export class Order {}\n',
    'src/orders/checkout.ts': 'export class Checkout {}\n',
    'src/billing/invoice.ts': 'export class Invoice {}\n',
    'src/util/log.ts': 'export const log = () => {}\n',
    'scripts/build.ts': 'build()\n',
    'scripts/release.ts': 'release()\n'
  }
}

/** The shop's code as the index holds it */
export function shopNodes(): GraphNode[] {
  return [
    fileNode('src/orders/model.ts', 40),
    sym('class', 'Order', 'src/orders/model.ts', [1, 20]),
    sym('method', 'total', 'src/orders/model.ts', [5, 8], { qualifiedName: 'Order::total' }),
    sym('method', 'lines', 'src/orders/model.ts', [10, 12], { qualifiedName: 'Order::lines' }),
    sym('class', 'OrderLine', 'src/orders/model.ts', [22, 30]),
    sym('function', 'helper', 'src/orders/model.ts', [32, 38]),
    fileNode('src/orders/checkout.ts', 60),
    sym('class', 'Checkout', 'src/orders/checkout.ts', [1, 50]),
    sym('method', 'start', 'src/orders/checkout.ts', [3, 20], { qualifiedName: 'Checkout::start' }),
    sym('method', 'finish', 'src/orders/checkout.ts', [22, 40], { qualifiedName: 'Checkout::finish' }),
    sym('variable', 'step', 'src/orders/checkout.ts', [25, 25]),
    fileNode('src/billing/invoice.ts', 30),
    sym('class', 'Invoice', 'src/billing/invoice.ts', [1, 30]),
    fileNode('src/util/log.ts', 5),
    sym('constant', 'log', 'src/util/log.ts', [1, 1]),
    fileNode('scripts/build.ts', 3),
    fileNode('scripts/release.ts', 3)
  ]
}
