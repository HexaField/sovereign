# Crons (`packages/scheduler/`)

A cron is a scheduled user message into one thread. It always has a target thread: `CronService` (`cron-service.ts`) refuses a blank `threadKey` and a thread that does not exist or is archived (`threadExists`, wired in `agent-backend/src/wiring.ts`), so the REST routes and the `cron_create` MCP tool share one check. The stored payload is `{ kind: 'sovereign.userMessage', threadKey, prompt, label }`; the key is the bare thread key, with no mapping.

The client manages crons only inside a thread: the thread settings dropdown (`features/crons/ThreadCrons.tsx`) lists that thread's crons (name, schedule, next run, last result) with turn on/off, run now, edit and delete, and an add form that always targets the open thread. There is no global cron manager; `GET /api/crons` still lists all crons for tools.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/crons` |  | `{ crons }` (each with `threadKey`, `state.nextRunAtMs`, `state.lastRunAtMs`, `state.lastStatus`) |
| `GET /api/threads/:key/crons` |  | the crons of one thread |
| `POST /api/crons` | `{ threadKey, name?, schedule, prompt }` | 201 `{ ok, cron }` |
| `PATCH /api/crons/:id` | `name`, `enabled`, `schedule`, `prompt`, `threadKey` | `{ ok, cron }` |
| `POST /api/crons/:id/run` |  | `{ ok }` |
| `DELETE /api/crons/:id` |  | `{ ok }` |

Errors are `{ error }`: 400 for a missing `threadKey`, an unknown thread, an empty prompt or a schedule that cannot run; 404 for an unknown cron id. `POST /api/jobs` refuses `sovereign.userMessage` payloads, and `PATCH /api/jobs/:id` refuses to change a cron's payload, thread or prompt (400).
