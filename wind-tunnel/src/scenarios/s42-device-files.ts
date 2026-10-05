// S42: the device file viewer. In the tunnel there is no tailnet, so the
// device monitor knows only this container, as the local device. The
// scenario lists a directory, waits for its folder sizes, downloads a file
// (bytes must match the listed size) and a directory (a gzip stream), and
// checks the errors: a missing path is 404, an unknown device is 404, a
// relative path is 400.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

export const s42DeviceFiles: Scenario = {
  id: 's42',
  name: 'Device Files',
  description: 'file viewer: list, folder sizes, download file + directory, errors',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const base = client.baseUrl
    const metrics: Record<string, unknown> = {}
    const problems: string[] = []

    const devices = (await client.get('/api/system/devices/metrics'))?.devices ?? []
    const device: string | undefined = devices.find((d: any) => d.local)?.hostname
    if (!device) return { passed: false, summary: 'no local device in metrics', metrics, samples: client.samples }
    const fs = `${base}/api/system/devices/${encodeURIComponent(device)}/fs`

    // 1. List /app/packages.
    const listRes = await fetch(`${fs}?path=/app/packages`)
    const listing = await listRes.json()
    const dirs = (listing.entries ?? []).filter((e: any) => e.type === 'dir').map((e: any) => e.name)
    metrics.dirs = dirs.length
    if (!listRes.ok || dirs.length < 5) problems.push(`listing: HTTP ${listRes.status}, ${dirs.length} dirs`)

    // 2. Folder sizes fill in until done.
    let sizes: any = {}
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      sizes = await (await fetch(`${fs}/sizes?path=/app/packages`)).json()
      if (sizes.done) break
      await new Promise((r) => setTimeout(r, 500))
    }
    const sized = Object.keys(sizes.sizes ?? {}).length
    metrics.sized = sized
    metrics.total = sizes.total
    if (!sizes.done || sized !== dirs.length || !(sizes.total > 0))
      problems.push(`sizes: done=${sizes.done} ${sized}/${dirs.length}`)

    // 3. Download a file: the bytes match the listed size.
    const appListing = await (await fetch(`${fs}?path=/app`)).json()
    const file = (appListing.entries ?? []).find((e: any) => e.name === 'package.json')
    const fileRes = await fetch(`${fs}/download?path=/app/package.json`)
    const fileBody = Buffer.from(await fileRes.arrayBuffer())
    metrics.fileBytes = fileBody.length
    if (!fileRes.ok || !file || fileBody.length !== file.size)
      problems.push(`file download: HTTP ${fileRes.status}, ${fileBody.length} vs ${file?.size}`)
    if (!/attachment; filename\*=UTF-8''package\.json/.test(fileRes.headers.get('content-disposition') ?? ''))
      problems.push(`file disposition: ${fileRes.headers.get('content-disposition')}`)

    // 4. Download a directory: a gzip stream named <dir>.tar.gz.
    const dirName = dirs[0]
    const dirRes = await fetch(`${fs}/download?path=/app/packages/${encodeURIComponent(dirName)}`)
    const dirBody = Buffer.from(await dirRes.arrayBuffer())
    metrics.dirBytes = dirBody.length
    if (!dirRes.ok || dirBody[0] !== 0x1f || dirBody[1] !== 0x8b)
      problems.push(`dir download: HTTP ${dirRes.status}, not gzip`)
    if (!(dirRes.headers.get('content-disposition') ?? '').includes(encodeURIComponent(`${dirName}.tar.gz`)))
      problems.push(`dir disposition: ${dirRes.headers.get('content-disposition')}`)

    // 5. Errors.
    const status = async (url: string) => (await fetch(url)).status
    const errors = {
      missing: await status(`${fs}?path=/app/no-such-dir`),
      missingDownload: await status(`${fs}/download?path=/app/no-such-file`),
      unknownDevice: await status(`${base}/api/system/devices/no-such-device/fs?path=/`),
      relative: await status(`${fs}?path=app`)
    }
    metrics.errors = errors
    if (
      errors.missing !== 404 ||
      errors.missingDownload !== 404 ||
      errors.unknownDevice !== 404 ||
      errors.relative !== 400
    )
      problems.push(`errors: ${JSON.stringify(errors)}`)

    const passed = problems.length === 0
    return {
      passed,
      summary: passed
        ? `${dirs.length} folders listed and sized (${(sizes.total / 1e6).toFixed(0)} MB); file ${fileBody.length} B matches; ${dirName}.tar.gz ${dirBody.length} B; errors 404/404/404/400`
        : problems.join('; '),
      metrics,
      samples: client.samples
    }
  }
}
