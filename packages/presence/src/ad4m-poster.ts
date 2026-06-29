// Thin AD4M poster — implements ResponseToolsDeps.ad4m by translating
// "post a child message" into the SDK calls required to add a message node
// to an AD4M channel.
//
// The protocol is intentionally minimal: a `has_child` link from the channel
// to a fresh UUID, plus a `message_body` link from that UUID to a literal
// string containing the body. App-specific link languages (Flux, etc.) may
// layer additional links on top — that's out of scope for the base presence
// reply tool.

import { randomUUID } from 'node:crypto'
import { Link } from '@coasys/ad4m'
import type { Ad4mClientManager } from '@sovereign/ad4m'
import type { Ad4mPoster } from './response-tools.js'

const HAS_CHILD = 'ad4m://has_child'
const MESSAGE_BODY = 'ad4m://message_body'

export function createAd4mPoster(clientManager: Ad4mClientManager): Ad4mPoster {
  return {
    async postChildMessage(perspectiveUuid, channelAddress, body) {
      const client = clientManager.getClient()
      if (!client) throw new Error('AD4M client not connected')

      // Mint a fresh message node address. AD4M doesn't impose a URI scheme,
      // but a UUID under a `presence://message/` prefix keeps it identifiable.
      const messageAddress = `presence://message/${randomUUID()}`
      const literalBody = `literal:string:${encodeURIComponent(body)}`

      await client.perspective.addLink(
        perspectiveUuid,
        new Link({ source: channelAddress, predicate: HAS_CHILD, target: messageAddress })
      )
      await client.perspective.addLink(
        perspectiveUuid,
        new Link({ source: messageAddress, predicate: MESSAGE_BODY, target: literalBody })
      )

      return { messageAddress }
    }
  }
}
