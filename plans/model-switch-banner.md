# Model Switch Banner

## Objective

Make model changes explicit inside the thread chat by showing a compact banner whenever the effective model for a thread/session switches.

## Requirements

- Render a compact centered banner in chat using the same visual treatment as compaction messages.
- Banner text format: `Model switched: <old-model> → <new-model>` plus a short timestamp.
- Emit the event from the server whenever a thread model changes through the thread model routes or when session-info rewrites a drifted model to the configured default.
- Deliver the event over both WS and SSE.
- Append the banner in the client chat store, dedupe repeated events, and keep it scoped to the active thread.

## Acceptance criteria

1. Given a thread model changes through `/api/threads/:key/model`, when the request succeeds, then active chat clients receive a `chat.model.switch` event and show a compact banner.
2. Given `/api/threads/:key/session-info` rewrites a drifted model to the configured default, when the rewrite happens, then active chat clients receive the same event and show the banner.
3. Given the same model switch event is delivered twice, when the client processes it, then only one banner is appended.
4. Given a model switch banner is rendered, when displayed in chat, then it uses the same compact styling path as compaction messages.
