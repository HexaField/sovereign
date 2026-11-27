# Hazard monitor (`packages/server/src/hazards/`)

Watches one property in Victoria and messages the **presence thread** (a queued system card, the same path as PR watch) only when something needs attention. Off by default; set `hazards` in the config (`enabled`, `lat`, `lon`, `label`, `fireDistrict`).

| Feed | Poll | Used for |
| --- | --- | --- |
| VicEmergency `events-geojson.json` | `pollMs` (90 s) | Warnings (level in `category1`, area as polygons) and incidents (points) |
| CFA `tfbfdrforecast_rss.xml` | `forecastPollMs` (30 min) | Total Fire Ban + BOM Fire Danger Rating per fire district, 5 days |

**The bar (`rules.ts`):** Watch and Act / Emergency Warning whose **polygon contains** the property (a warning's incident point beside the property does not count); an uncontrolled vegetation fire within `fireRadiusKm` (5) or any uncontrolled fire within `anyFireRadiusKm` (1); a fire ban or an Extreme/Catastrophic rating for today or tomorrow. Then one message when an alerted item escalates and one when it eases or ends; ratings rolling off the forecast are silent. Advice-level warnings, distant fires and High ratings never message. If VicEmergency stays unreadable 30 min on a fire-ban/High+ day, one "feed down" message.

- **One fire, two records:** VicEmergency can list one fire twice (a CFA incident and a 000 dispatch event, ids apart, 20 m apart). Fire records within `SAME_FIRE_KM` (1 km) of each other count as one fire: only the first is announced, and "eased" goes out once, when the last record ends. Each fire item stores a point (`at`) for this. Two separate fires within 1 km of each other also share one alert.
- **Feed ids:** VicEmergency gives a warning a new `id` on every reissue (seen hourly in Jan 2026), so warnings key by hazard (`warning:fire`, `warning:riverine flood`) at the highest covering level. NSW RFS incident ids embed the update time, so they key by `sourceOrg:sourceId`. VIC incident ids (`ESTA:…`, DEECA numbers) stay stable.
- Fires: `category1` "Fire", or any vegetation `category2` (FRV files "Grass and Scrub" under "Other"). A mapped burnt area counts as vegetation. The district-wide "Fire Danger Rating" / "Total Fire Ban" pseudo-incidents never count as fires. Unknown warning levels and fire statuses count as active.
- "Eased" goes out only after an item is absent for `EASE_AFTER` (3) reads, so a gap between reissues is silent.
- State (alerted keys, last "feed down" date) persists in `<dataDir>/hazards/state.json`, so restarts never repeat an alert. Each sent message commits its state; a failed send retries next poll without repeating earlier ones. The loop always runs; `enabled` hot-reloads.
- `GET /api/hazards` returns the current state, outlook and feed timestamps.
- Tests use real captures in `hazards/fixtures/` (public data) plus synthetic warnings/fires; there is no wind-tunnel scenario (the feeds are external).
