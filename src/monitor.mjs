import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const APP_FILE = fileURLToPath(new URL('./app.html', import.meta.url))
const PROFILE_NAME = /^[A-Za-z0-9_-]{1,32}$/
const MAX_BODY = 4096
const APP_ID = 'clauth-workstation'
const VERSION = '1.0.0'

function readJson(file) {
  // Older PowerShell writes a BOM; a daemon write may briefly be incomplete.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) }
    catch { /* Missing, incomplete or invalid data is unavailable, never zero. */ }
  }
  return null
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function percentage(value) {
  const number = numberOrNull(value)
  return number === null ? null : Math.min(100, Math.max(0, number))
}

function validDate(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  return value
}

function stringOrNull(value) {
  return typeof value === 'string' ? value.slice(0, 256) : null
}

function readTail(file, bytes = 128 * 1024) {
  let descriptor
  try {
    descriptor = fs.openSync(file, 'r')
    const size = fs.fstatSync(descriptor).size
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(descriptor, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } catch { return '' }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}

function configuration(root) {
  const toml = readText(path.join(root, 'profiles.toml')).replace(/^\s*#.*$/gm, '')
  const active = (/^\s*active_profile\s*=\s*"([^"]+)"/m.exec(toml) || [])[1] || null
  const body = (/^\s*fallback_chain\s*=\s*\[([^\]]*)\]/m.exec(toml) || [])[1] || ''
  const chain = [...new Set([...body.matchAll(/"([^"]+)"/g)].map(match => match[1]).filter(name => PROFILE_NAME.test(name)))]
  const weeklyLimit = percentage((/^\s*weekly_switch_threshold\s*=\s*([\d.]+)/m.exec(toml) || [])[1])
    ?? percentage((/^\s*weekly_threshold\s*=\s*([\d.]+)/m.exec(toml) || [])[1]) ?? 98
  return { active: PROFILE_NAME.test(active || '') ? active : null, chain, weeklyLimit }
}

function flags(root, name) {
  const toml = readText(path.join(root, 'profiles', name, 'config.toml'))
  const numeric = key => percentage((new RegExp('^\\s*' + key + '\\s*=\\s*([\\d.]+)', 'm').exec(toml) || [])[1])
  return {
    lastResort: /^\s*last_resort\s*=\s*true/m.test(toml),
    checkScoped: /^\s*check_scoped\s*=\s*(true|false)/m.test(toml)
      ? /^\s*check_scoped\s*=\s*true/m.test(toml) : null,
    fallbackThreshold: numeric('fallback_threshold'), weeklyThreshold: numeric('weekly_threshold'),
  }
}

function history(root, name) {
  const rows = new Map()
  for (const line of readTail(path.join(root, 'profiles', name, 'usage_history.jsonl')).split('\n')) {
    try {
      const row = JSON.parse(line)
      const ts = numberOrNull(row.ts)
      if (!ts || !row.usage) continue
      const scoped = Array.isArray(row.usage.weekly_scoped) ? row.usage.weekly_scoped : []
      rows.set(ts, { ts, five: percentage(row.usage.five_hour?.utilization),
        seven: percentage(row.usage.seven_day?.utilization),
        fable: percentage(scoped.find(window => window?.label === '7d fable')?.utilization) })
    } catch { /* Ignore incomplete append. */ }
  }
  return [...rows.values()].sort((a, b) => a.ts - b.ts)
}

function burnRate(rows, key) {
  const known = rows.filter(row => row[key] !== null)
  if (known.length < 2) return null
  const last = known.at(-1)
  const segment = known.filter(row => row.ts >= last.ts - 20 * 60000)
  if (segment.length < 2 || last.ts - segment[0].ts < 60000) return null
  // A reset breaks this observation window; do not estimate across that reset.
  if (segment.some((row, index) => index > 0 && row[key] < segment[index - 1][key])) return null
  return (last[key] - segment[0][key]) / ((last.ts - segment[0].ts) / 60000)
}

function refreshToken(file) {
  const token = readJson(file)?.claudeAiOauth?.refreshToken
  return typeof token === 'string' && token ? token : null
}

function automationView(value) {
  // Never forward arbitrary callback output or log contents to the browser.
  const out = { sampledAt: Date.now() }
  for (const key of ['watchdog', 'heal', 'sync', 'reorder']) {
    const task = value?.[key]
    out[key] = {
      task: stringOrNull(task?.task) || key,
      installed: task?.installed === true, enabled: task?.enabled === true,
      running: task?.running === true, scriptMissing: task?.scriptMissing === true,
      lastRun: stringOrNull(task?.lastRun),
      lastResult: numberOrNull(task?.lastResult),
      status: typeof task?.status === 'string' && /^[a-z-]{1,40}$/.test(task.status) ? task.status : null,
    }
  }
  out.daemon = { running: typeof value?.daemon?.running === 'boolean' ? value.daemon.running : null,
    pid: numberOrNull(value?.daemon?.pid) }
  return out
}

/** Read-only projection. Credentials are compared locally and are never returned. */
export function buildState({ root, livePath, readOnly = false, automation = {} }) {
  const raw = readJson(path.join(root, 'status.json'))
  const unsupportedSchema = raw?.schema !== undefined && ![1, 2].includes(raw.schema)
  const status = raw && typeof raw === 'object' && !Array.isArray(raw) && !unsupportedSchema ? raw : null
  const { active, chain, weeklyLimit } = configuration(root)
  const emails = readJson(path.join(root, 'account-emails.json')) || {}
  const rows = Array.isArray(status?.profiles) ? status.profiles.filter(profile => profile &&
    (profile.harness ?? 'claude') === 'claude' && typeof profile.name === 'string' && PROFILE_NAME.test(profile.name)) : []
  const liveToken = livePath ? refreshToken(livePath) : null
  let liveProfile = null
  if (liveToken) {
    const matches = rows.filter(profile => refreshToken(path.join(root, 'profiles', profile.name, 'credentials.json')) === liveToken)
    if (matches.length === 1) liveProfile = matches[0].name
  }
  const generatedAt = validDate(status?.generated_at) ? Date.parse(status.generated_at) : null
  const ageSec = generatedAt === null ? null : Math.round((Date.now() - generatedAt) / 1000)
  const refreshMs = Math.max(1000, numberOrNull(status?.refresh_interval_ms) ?? 90000)
  const freshnessLimitSec = Math.max(300, refreshMs / 1000 * 3)
  const profiles = rows.map(profile => {
    const windows = Array.isArray(profile.windows) ? profile.windows : []
    const window = label => windows.find(item => item?.label === label) || {}
    const five = window('5h'), seven = window('7d'), fable = window('7d fable')
    const profileFlags = flags(root, profile.name)
    const hist = history(root, profile.name)
    const uuid = readJson(path.join(root, 'profiles', profile.name, 'account_id.json'))
    const fivePct = percentage(five.utilization_pct), fablePct = percentage(fable.utilization_pct)
    const burnFable = burnRate(hist, 'fable'), burnFive = burnRate(hist, 'five')
    const fallbackThreshold = percentage(profile.fallback?.threshold) ?? profileFlags.fallbackThreshold ?? 85
    return {
      name: profile.name, email: typeof uuid === 'string' ? stringOrNull(emails[uuid]) : null,
      tier: stringOrNull(profile.tier), authStatus: stringOrNull(profile.auth_status) || 'unknown',
      active: profile.name === active, live: profile.name === liveProfile,
      chainPos: chain.indexOf(profile.name) >= 0 ? chain.indexOf(profile.name) + 1 : null,
      ...profileFlags, fallbackThreshold, weeklyThreshold: profileFlags.weeklyThreshold ?? weeklyLimit,
      five: fivePct, seven: percentage(seven.utilization_pct), fable: fablePct,
      fiveResets: validDate(five.resets_at), sevenResets: validDate(seven.resets_at), fableResets: validDate(fable.resets_at),
      otherWindows: windows.filter(item => item && !['5h', '7d', '7d fable'].includes(item.label)).map(item => ({
        label: stringOrNull(item.label) || 'Unknown', utilization: percentage(item.utilization_pct), resetsAt: validDate(item.resets_at),
      })),
      burnFable, burnFive,
      etaFableMin: fablePct !== null && burnFable > 0.02 ? Math.max(0, (100 - fablePct) / burnFable) : null,
      etaFiveMin: fivePct !== null && burnFive > 0.02 ? Math.max(0, (fallbackThreshold - fivePct) / burnFive) : null,
      spark: hist.filter(row => row.fable !== null).slice(-48).map(row => row.fable), stale: !!profile.stale,
    }
  })
  const order = new Map(chain.map((name, index) => [name, index]))
  profiles.sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999))
  let appVersion = 0
  try { appVersion = fs.statSync(APP_FILE).mtimeMs } catch { }
  let configuredProfiles = []
  try {
    configuredProfiles = fs.readdirSync(path.join(root, 'profiles'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && PROFILE_NAME.test(entry.name)).map(entry => entry.name)
  } catch { }
  const missingProfiles = configuredProfiles.filter(name => !profiles.some(profile => profile.name === name))
  return {
    ok: !!status, unsupportedSchema, schema: status?.schema ?? null, appVersion, now: Date.now(), generatedAt, ageSec, refreshMs,
    // This measures published state freshness, not process liveness.
    daemonUp: ageSec !== null && ageSec >= -5 && ageSec < freshnessLimitSec,
    freshnessLimitSec, activeProfile: active, liveProfile, liveResolved: !!liveProfile,
    desync: !!(active && liveProfile && active !== liveProfile), weeklyLimit, chain, profiles,
    automation: automationView(automation), readOnly,
    configuredProfileCount: configuredProfiles.length, missingProfiles,
  }
}

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  })
  response.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0, body = '', rejected = false
    request.setEncoding('utf8')
    request.on('data', chunk => {
      size += Buffer.byteLength(chunk)
      if (size > MAX_BODY) {
        if (!rejected) { rejected = true; reject({ status: 413, error: 'body_too_large' }) }
      } else if (!rejected) body += chunk
    })
    request.on('end', () => {
      if (rejected) return
      try {
        const value = JSON.parse(body)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        resolve(value)
      } catch { reject({ status: 400, error: 'invalid_json' }) }
    })
    request.on('error', () => reject({ status: 400, error: 'request_failed' }))
    request.on('aborted', () => reject({ status: 400, error: 'request_failed' }))
  })
}

function equalToken(value, expected) {
  if (typeof value !== 'string') return false
  const actual = Buffer.from(value), wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

/** Returns an unbound server. The caller must listen on a loopback address. */
export function createMonitor({ root, livePath, stateDir, port = 47821, readOnly = false,
  switchProfile, ensureDaemon, automationState = () => ({}) }) {
  if (!root || !path.isAbsolute(root)) throw new TypeError('root must be an absolute path')
  const csrfToken = randomBytes(32).toString('hex')
  let queue = Promise.resolve()
  let pendingActions = 0
  const serial = action => {
    const result = queue.then(action, action)
    queue = result.catch(() => {})
    return result
  }
  const server = http.createServer(async (request, response) => {
    try {
      const boundPort = server.address()?.port || port
      const host = request.headers.host
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]
      if (!allowedHosts.includes(host)) return send(response, 403, { ok: false, error: 'invalid_host' })
      if (request.headers.origin && request.headers.origin !== `http://${host}`) {
        return send(response, 403, { ok: false, error: 'invalid_origin' })
      }
      const url = new URL(request.url, `http://${host}`)
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return send(response, 200, { ok: true, app: APP_ID, version: VERSION })
      }
      if (request.method === 'GET' && url.pathname === '/api/session') {
        return send(response, 200, { ok: true, csrfToken, readOnly })
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        let automation = {}
        try { automation = await automationState() } catch { /* Unknown automation is rendered as unavailable. */ }
        return send(response, 200, buildState({ root, livePath, readOnly, automation }))
      }
      if (['/api/switch', '/api/daemon-start'].includes(url.pathname)) {
        if (request.method !== 'POST') return send(response, 405, { ok: false, error: 'method_not_allowed' })
        if (request.headers.origin !== `http://${host}`) return send(response, 403, { ok: false, error: 'invalid_origin' })
        if (!equalToken(request.headers['x-clauth-csrf'], csrfToken)) return send(response, 403, { ok: false, error: 'invalid_csrf' })
        if (readOnly) return send(response, 403, { ok: false, error: 'read_only' })
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
          return send(response, 415, { ok: false, error: 'json_required' })
        }
        if (Number(request.headers['content-length']) > MAX_BODY) return send(response, 413, { ok: false, error: 'body_too_large' })
        const body = await readBody(request)
        const switching = url.pathname === '/api/switch'
        if (switching && (typeof body.to !== 'string' || !PROFILE_NAME.test(body.to))) {
          return send(response, 400, { ok: false, error: 'invalid_profile' })
        }
        if (switching) {
          let valid = false
          try { valid = fs.lstatSync(path.join(root, 'profiles', body.to)).isDirectory() } catch { }
          if (!valid) return send(response, 404, { ok: false, error: 'profile_not_found' })
        }
        const action = switching ? switchProfile : ensureDaemon
        if (typeof action !== 'function') return send(response, 503, { ok: false, error: 'action_unavailable' })
        if (pendingActions >= 8) return send(response, 429, { ok: false, error: 'action_queue_full' })
        pendingActions++
        let result
        try { result = await serial(() => switching ? action(body.to) : action()) }
        catch { result = { ok: false } }
        finally { pendingActions-- }
        // Even callback errors/CLI diagnostics may contain secrets. Only return
        // fixed public codes; detailed diagnostics belong in protected local logs.
        const ok = result?.ok === true
        return send(response, ok ? 200 : 409, {
          ok, ...(switching ? { to: body.to } : {}),
          ...(ok ? {} : { error: switching ? 'switch_failed' : 'daemon_start_failed' }),
        })
      }
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/app.html')) {
        return send(response, 200, fs.readFileSync(APP_FILE, 'utf8'), 'text/html; charset=utf-8')
      }
      return send(response, 404, { ok: false, error: 'not_found' })
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const publicErrors = ['body_too_large', 'invalid_json', 'request_failed']
        const safe = publicErrors.includes(error?.error)
        send(response, safe ? error.status : 500, { ok: false, error: safe ? error.error : 'internal_error' })
      }
    }
  })
  server.requestTimeout = 10000
  server.headersTimeout = 10000
  server.keepAliveTimeout = 5000
  return server
}
