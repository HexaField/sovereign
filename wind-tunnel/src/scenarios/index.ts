// All wind-tunnel scenarios, in execution order.

import type { Scenario } from '../scenario.js'
import { s1ColdStart } from './s1-cold-start.js'
import { s2ThreadLifecycle } from './s2-thread-lifecycle.js'
import { s3ChatRoundtrip } from './s3-chat-roundtrip.js'
import { s4Presence } from './s4-presence.js'
import { s5ThreadMessaging } from './s5-thread-messaging.js'
import { s6Scheduler } from './s6-scheduler.js'
import { s7WsEvents } from './s7-ws-events.js'
import { s8ConfigMembranes } from './s8-config-membranes.js'
import { s9SessionResume } from './s9-session-resume.js'
import { s10Ad4mWaker } from './s10-ad4m-waker.js'
import { s11ContextFilter } from './s11-context-filter.js'
import { s12SessionRecycle } from './s12-session-recycle.js'
import { s13SessionCleanup } from './s13-session-cleanup.js'
import { s14LocalLlmBackend } from './s14-local-llm-backend.js'
import { s15SummaryService } from './s15-summary-service.js'
import { s16AutoRecycle } from './s16-auto-recycle.js'
import { s17BackendMixing } from './s17-backend-mixing.js'
import { s18LlmBenchmark } from './s18-llm-benchmark.js'

export const ALL_SCENARIOS: Scenario[] = [
  s1ColdStart,
  s2ThreadLifecycle,
  s3ChatRoundtrip,
  s4Presence,
  s5ThreadMessaging,
  s6Scheduler,
  s7WsEvents,
  s8ConfigMembranes,
  s9SessionResume,
  // Self-skips unless the ad4m lane is active (docker-compose.ad4m.yml).
  s10Ad4mWaker,
  // Context management (plans/context-management.md) — self-skip when
  // feature endpoints return 404 (pre-implementation baseline).
  s11ContextFilter,
  s12SessionRecycle,
  s13SessionCleanup,
  // local-llm-backend.md (plans/) — s14 tests the mock's OpenAI-compatible
  // surface directly (no real backend to route through yet); s15 self-skips
  // when the summary service's endpoints return 404 (pre-implementation).
  s14LocalLlmBackend,
  s15SummaryService,
  // Auto-recycle (Layer 2 auto-trigger) and backend mixing (per-thread
  // backend selection). Both self-skip when their endpoints return 404.
  s16AutoRecycle,
  s17BackendMixing,
  // LLM benchmark — configurable prompt via SWT_BENCHMARK_PROMPT env var.
  // Self-skips when the variable has no value or local-llm backend absent.
  s18LlmBenchmark
]
