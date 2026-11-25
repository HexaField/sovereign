// A thread's crons, managed in place inside the thread settings dropdown:
// one compact row per cron, and an add/edit form that always targets this thread.
import { createSignal, createEffect, on, Show, For } from 'solid-js'
import {
  formatSchedule,
  formatNextRun,
  formatLastRun,
  formFromJob,
  validateCronForm,
  type CronFormField,
  type CronFormValues,
  type CronJob,
  type IntervalUnit,
  type ScheduleMode
} from './cron-model.js'

const MODES: Array<{ id: ScheduleMode; label: string }> = [
  { id: 'cron', label: 'Cron' },
  { id: 'interval', label: 'Every' },
  { id: 'oneshot', label: 'Once' }
]
const UNITS: IntervalUnit[] = ['minutes', 'hours', 'days']

const fieldStyle = {
  width: '100%',
  padding: '4px 6px',
  'border-radius': '6px',
  border: '1px solid var(--c-border)',
  background: 'var(--c-bg)',
  color: 'var(--c-text)',
  'font-size': '12px',
  'box-sizing': 'border-box'
} as const

const linkButton = (color = 'var(--c-accent)') =>
  ({
    padding: '0',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    color,
    'font-size': '10px'
  }) as const

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json()
    if (typeof data?.error === 'string') return data.error.replace(/^cron: /, '')
  } catch {
    /* no body */
  }
  return `Request failed (${res.status})`
}

export function ThreadCrons(props: { threadKey: string }) {
  const [crons, setCrons] = createSignal<CronJob[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [formFor, setFormFor] = createSignal<'new' | string | null>(null)
  const [values, setValues] = createSignal<CronFormValues>(formFromJob())
  const [fieldErrors, setFieldErrors] = createSignal<Partial<Record<CronFormField, string>>>({})
  const [formError, setFormError] = createSignal('')
  const [saving, setSaving] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [rowError, setRowError] = createSignal('')

  const load = async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(props.threadKey)}/crons`, {
        signal: controller.signal
      })
      if (res.ok) setCrons(((await res.json()).crons ?? []) as CronJob[])
    } catch {
      /* keep what is shown */
    } finally {
      clearTimeout(timeout)
      setLoaded(true)
    }
  }

  createEffect(
    on(
      () => props.threadKey,
      () => {
        setFormFor(null)
        setConfirmDelete(null)
        setLoaded(false)
        setCrons([])
        void load()
      }
    )
  )

  const openForm = (job?: CronJob) => {
    setValues(formFromJob(job))
    setFieldErrors({})
    setFormError('')
    setFormFor(job ? job.id : 'new')
  }
  const patch = (p: Partial<CronFormValues>) => setValues((v) => ({ ...v, ...p }))

  const submit = async (e: Event) => {
    e.preventDefault()
    const result = validateCronForm(values())
    if (!result.ok) {
      setFieldErrors(result.errors)
      return
    }
    setFieldErrors({})
    setFormError('')
    setSaving(true)
    const editing = formFor() !== 'new' ? crons().find((c) => c.id === formFor()) : undefined
    const name = result.body.name ?? editing?.name ?? result.body.prompt.slice(0, 40)
    try {
      const res = editing
        ? await fetch(`/api/crons/${encodeURIComponent(editing.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, schedule: result.body.schedule, prompt: result.body.prompt })
          })
        : await fetch('/api/crons', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...result.body, name, threadKey: props.threadKey })
          })
      if (!res.ok) {
        setFormError(await readError(res))
        return
      }
      setFormFor(null)
      await load()
    } catch {
      setFormError("Couldn't reach the server. Try again.")
    } finally {
      setSaving(false)
    }
  }

  /** Run one row action, then reload; an error shows under the list. */
  const act = async (job: CronJob, request: () => Promise<Response>) => {
    setBusy(job.id)
    setRowError('')
    try {
      const res = await request()
      if (!res.ok) setRowError(await readError(res))
    } catch {
      setRowError("Couldn't reach the server. Try again.")
    }
    setBusy(null)
    await load()
  }
  const url = (job: CronJob, suffix = '') => `/api/crons/${encodeURIComponent(job.id)}${suffix}`
  const toggle = (job: CronJob) =>
    act(job, () =>
      fetch(url(job), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !job.enabled })
      })
    )
  const runNow = (job: CronJob) => act(job, () => fetch(url(job, '/run'), { method: 'POST' }))
  const remove = (job: CronJob) => {
    setConfirmDelete(null)
    return act(job, () => fetch(url(job), { method: 'DELETE' }))
  }

  const errorText = (field: CronFormField) => (
    <Show when={fieldErrors()[field]}>
      <div class="text-[10px]" style={{ color: 'var(--c-error, #ef4444)', 'margin-top': '2px' }}>
        {fieldErrors()[field]}
      </div>
    </Show>
  )

  const form = () => (
    <form
      onSubmit={submit}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '6px',
        padding: '8px',
        'border-radius': '6px',
        background: 'var(--c-bg)',
        border: '1px solid var(--c-border)'
      }}
    >
      <input
        type="text"
        aria-label="Name"
        placeholder="Name (optional)"
        value={values().name}
        onInput={(e) => patch({ name: e.currentTarget.value })}
        style={fieldStyle}
      />
      <div style={{ display: 'flex', gap: '4px' }}>
        <For each={MODES}>
          {(m) => (
            <button
              type="button"
              class="text-xs"
              onClick={() => patch({ mode: m.id })}
              style={{
                flex: '1',
                padding: '3px 0',
                'border-radius': '6px',
                cursor: 'pointer',
                border: '1px solid var(--c-border)',
                background: values().mode === m.id ? 'var(--c-accent)' : 'transparent',
                color: values().mode === m.id ? 'var(--c-bg)' : 'var(--c-text)'
              }}
            >
              {m.label}
            </button>
          )}
        </For>
      </div>
      <Show when={values().mode === 'cron'}>
        <div>
          <input
            type="text"
            aria-label="Cron expression"
            placeholder="0 9 * * *"
            value={values().expr}
            onInput={(e) => patch({ expr: e.currentTarget.value })}
            style={{ ...fieldStyle, 'font-family': 'monospace' }}
          />
          {errorText('expr')}
        </div>
      </Show>
      <Show when={values().mode === 'interval'}>
        <div>
          <div style={{ display: 'flex', gap: '4px' }}>
            <input
              type="number"
              min="1"
              aria-label="Interval"
              value={values().every}
              onInput={(e) => patch({ every: e.currentTarget.value })}
              style={{ ...fieldStyle, width: '70px' }}
            />
            <select
              aria-label="Interval unit"
              value={values().unit}
              onChange={(e) => patch({ unit: e.currentTarget.value as IntervalUnit })}
              style={fieldStyle}
            >
              <For each={UNITS}>{(u) => <option value={u}>{u}</option>}</For>
            </select>
          </div>
          {errorText('every')}
        </div>
      </Show>
      <Show when={values().mode === 'oneshot'}>
        <div>
          <input
            type="datetime-local"
            aria-label="Run at"
            value={values().at}
            onInput={(e) => patch({ at: e.currentTarget.value })}
            style={fieldStyle}
          />
          {errorText('at')}
        </div>
      </Show>
      <div>
        <textarea
          aria-label="Message"
          placeholder="What should this thread do?"
          rows={3}
          value={values().prompt}
          onInput={(e) => patch({ prompt: e.currentTarget.value })}
          style={{ ...fieldStyle, resize: 'vertical' }}
        />
        {errorText('prompt')}
      </div>
      <Show when={formError()}>
        <div class="text-[10px]" role="alert" style={{ color: 'var(--c-error, #ef4444)' }}>
          {formError()}
        </div>
      </Show>
      <div style={{ display: 'flex', gap: '6px', 'justify-content': 'flex-end' }}>
        <button
          type="button"
          class="text-xs"
          onClick={() => setFormFor(null)}
          style={{ ...linkButton('var(--c-text-muted)'), 'font-size': '12px', padding: '3px 8px' }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving()}
          class="text-xs"
          style={{
            padding: '3px 10px',
            'border-radius': '6px',
            border: 'none',
            cursor: 'pointer',
            'font-weight': '500',
            background: 'var(--c-accent)',
            color: 'var(--c-bg)'
          }}
        >
          {formFor() === 'new' ? 'Add cron' : 'Save'}
        </button>
      </div>
    </form>
  )

  return (
    <div style={{ 'margin-top': '10px', 'padding-top': '10px', 'border-top': '1px solid var(--c-border)' }}>
      <div class="text-xs font-medium" style={{ color: 'var(--c-text-heading)', 'margin-bottom': '6px' }}>
        Crons{crons().length > 0 ? ` (${crons().length})` : ''}
      </div>
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
        <For each={crons()}>
          {(job) => (
            <Show when={formFor() !== job.id} fallback={form()}>
              <div
                class="text-xs"
                style={{
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '2px',
                  padding: '4px 6px',
                  'border-radius': '6px',
                  background: 'var(--c-bg)',
                  color: 'var(--c-text)',
                  opacity: busy() === job.id ? '0.6' : '1'
                }}
              >
                <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                  <span
                    style={{
                      width: '6px',
                      height: '6px',
                      'border-radius': '50%',
                      background: job.enabled ? 'var(--c-success, #22c55e)' : 'var(--c-text-muted)',
                      'flex-shrink': '0'
                    }}
                  />
                  <span
                    style={{
                      flex: '1',
                      'min-width': '0',
                      overflow: 'hidden',
                      'text-overflow': 'ellipsis',
                      'white-space': 'nowrap'
                    }}
                    title={job.payload?.message}
                  >
                    {job.name || job.id}
                  </span>
                  <span style={{ color: 'var(--c-text-muted)', 'flex-shrink': '0', 'font-size': '10px' }}>
                    {formatSchedule(job.schedule)}
                  </span>
                </div>
                <div style={{ color: 'var(--c-text-muted)', 'font-size': '10px', 'padding-left': '12px' }}>
                  {[job.enabled ? formatNextRun(job.state?.nextRunAtMs) : 'Off', formatLastRun(job.state)]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <Show
                  when={confirmDelete() !== job.id}
                  fallback={
                    <div style={{ display: 'flex', gap: '8px', 'padding-left': '12px', 'align-items': 'center' }}>
                      <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                        This cron won't run again.
                      </span>
                      <button style={linkButton('var(--c-error, #ef4444)')} onClick={() => remove(job)}>
                        Delete
                      </button>
                      <button style={linkButton('var(--c-text-muted)')} onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </button>
                    </div>
                  }
                >
                  <div style={{ display: 'flex', gap: '10px', 'padding-left': '12px' }}>
                    <button style={linkButton()} disabled={busy() === job.id} onClick={() => toggle(job)}>
                      {job.enabled ? 'Turn off' : 'Turn on'}
                    </button>
                    <button style={linkButton()} disabled={busy() === job.id} onClick={() => runNow(job)}>
                      Run now
                    </button>
                    <button style={linkButton()} onClick={() => openForm(job)}>
                      Edit
                    </button>
                    <button style={linkButton('var(--c-error, #ef4444)')} onClick={() => setConfirmDelete(job.id)}>
                      Delete
                    </button>
                  </div>
                </Show>
              </div>
            </Show>
          )}
        </For>
        <Show when={loaded() && crons().length === 0 && formFor() === null}>
          <div class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
            No crons in this thread.
          </div>
        </Show>
      </div>
      <Show when={rowError()}>
        <div class="text-[10px]" role="alert" style={{ color: 'var(--c-error, #ef4444)', 'margin-top': '4px' }}>
          {rowError()}
        </div>
      </Show>
      <Show
        when={formFor() === 'new'}
        fallback={
          <Show when={formFor() === null}>
            <button
              class="cursor-pointer text-xs"
              style={{
                'margin-top': '6px',
                padding: '4px 10px',
                'border-radius': '6px',
                border: '1px solid var(--c-border)',
                background: 'transparent',
                color: 'var(--c-accent)',
                cursor: 'pointer',
                'font-weight': '500',
                width: '100%',
                'text-align': 'center'
              }}
              onClick={() => openForm()}
            >
              Add cron
            </button>
          </Show>
        }
      >
        <div style={{ 'margin-top': '6px' }}>{form()}</div>
      </Show>
    </div>
  )
}
