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
  s10Ad4mWaker
]
