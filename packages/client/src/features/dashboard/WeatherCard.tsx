import { createSignal, onMount, Show, For } from 'solid-js'

interface ForecastDay {
  date: string
  maxC: number
  minC: number
  condition: string
}

interface WeatherData {
  location: string
  tempC: number
  feelsLikeC: number
  humidity: number
  windKph: number
  windDir: string
  condition: string
  forecast: ForecastDay[]
  error?: string
}

function weatherEmoji(condition: string): string {
  const c = condition.toLowerCase()
  if (c.includes('sunny') || c.includes('clear')) return '☀'
  if (c.includes('cloud') && c.includes('partly')) return '⛅'
  if (c.includes('cloud') || c.includes('overcast')) return '☁'
  if (c.includes('rain') || c.includes('drizzle')) return '🌧'
  if (c.includes('thunder') || c.includes('storm')) return '⛈'
  if (c.includes('snow') || c.includes('sleet')) return '🌨'
  if (c.includes('fog') || c.includes('mist')) return '🌫'
  return '🌤'
}

function formatDay(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00')
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const diff = d.getTime() - today.getTime()
    if (diff < 0) return 'Today'
    if (diff < 86400_000) return 'Today'
    if (diff < 172800_000) return 'Tomorrow'
    return d.toLocaleDateString('en-AU', { weekday: 'short' })
  } catch {
    return dateStr
  }
}

export default function WeatherCard() {
  const [weather, setWeather] = createSignal<WeatherData | null>(null)

  onMount(async () => {
    try {
      const res = await fetch('/api/system/weather')
      if (res.ok) setWeather(await res.json())
    } catch {
      /* ignore */
    }
  })

  return (
    <div class="rounded-lg border p-3" style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }}>
      <h3 class="mb-2 text-xs font-semibold" style={{ color: 'var(--c-text-heading)' }}>
        Weather
      </h3>

      <Show when={weather()} fallback={<p class="text-[11px] opacity-40">Loading...</p>}>
        {(w) => (
          <Show when={!w().error} fallback={<p class="text-[11px] opacity-40">{w().error}</p>}>
            <div>
              <div class="flex items-start gap-2">
                <span class="text-2xl leading-none">{weatherEmoji(w().condition)}</span>
                <div>
                  <div class="flex items-baseline gap-1">
                    <span class="text-lg leading-none font-semibold" style={{ color: 'var(--c-text)' }}>
                      {w().tempC}°
                    </span>
                    <span class="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
                      feels {w().feelsLikeC}°
                    </span>
                  </div>
                  <p class="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
                    {w().condition}
                  </p>
                </div>
              </div>

              <div class="mt-1.5 flex gap-3 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                <span>Humidity {w().humidity}%</span>
                <span>
                  Wind {w().windKph} km/h {w().windDir}
                </span>
              </div>

              <Show when={w().forecast.length > 0}>
                <div
                  class="mt-2 flex gap-1"
                  style={{ 'border-top': '1px solid var(--c-border)', 'padding-top': '0.5rem' }}
                >
                  <For each={w().forecast}>
                    {(day) => (
                      <div class="flex-1 text-center">
                        <div class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                          {formatDay(day.date)}
                        </div>
                        <div class="text-sm leading-none">{weatherEmoji(day.condition)}</div>
                        <div class="mt-0.5 text-[10px]" style={{ color: 'var(--c-text)' }}>
                          {day.maxC}° / {day.minC}°
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
        )}
      </Show>
    </div>
  )
}
