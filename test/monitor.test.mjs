import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import vm from 'node:vm'
import { once } from 'node:events'
import { buildState, createMonitor } from '../src/monitor.mjs'

function fixture(t, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clauth-monitor-test-'))
  const root = path.join(temp, 'state'), livePath = path.join(temp, 'live.json')
  fs.mkdirSync(root)
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value))
  for (const name of ['alpha', 'beta']) {
    const dir = path.join(root, 'profiles', name)
    fs.mkdirSync(dir, { recursive: true })
    write(path.join(dir, 'credentials.json'), { claudeAiOauth: { refreshToken: 'SYNTHETIC_SECRET_' + name, accessToken: 'SYNTHETIC_ACCESS' } })
    write(path.join(dir, 'account_id.json'), 'uuid-' + name)
    fs.writeFileSync(path.join(dir, 'config.toml'), 'check_scoped = true\n')
  }
  write(livePath, { claudeAiOauth: { refreshToken: 'SYNTHETIC_SECRET_alpha' } })
  write(path.join(root, 'account-emails.json'), { 'uuid-alpha': '<img src=x onerror=alert(1)>@example.invalid' })
  fs.writeFileSync(path.join(root, 'profiles.toml'), 'active_profile = "alpha"\nfallback_chain = ["alpha", "beta"]\nweekly_switch_threshold = 94\n')
  const status = { schema: 2, generated_at: new Date().toISOString(), refresh_interval_ms: 90000,
    profiles: ['alpha', 'beta'].map(name => ({ name, harness: 'claude', auth_status: 'ok', tier: 'Max', windows: [
      { label: '5h', utilization_pct: 30 }, { label: '7d', utilization_pct: 40 }, { label: '7d fable', utilization_pct: 50 },
    ] })) }
  write(path.join(root, 'status.json'), status)
  return { root, livePath, write, status, ...options }
}

async function start(t, options = {}) {
  const state = fixture(t)
  const server = createMonitor({ ...state, ...options, port: 0 })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const port = server.address().port, origin = 'http://127.0.0.1:' + port
  const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        let json
        try { json = JSON.parse(data) } catch { }
        resolve({ status: res.statusCode, headers: res.headers, data, json })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
  const session = await request('/api/session')
  const mutation = (url, body = {}, overrides = {}) => request(url, {
    method: 'POST', body: JSON.stringify(body), ...overrides,
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Clauth-CSRF': session.json.csrfToken, ...overrides.headers },
  })
  return { ...state, server, request, mutation, origin }
}

test('state shows known usage, preserves unknown values, and never exposes credentials', t => {
  const state = fixture(t)
  state.status.profiles[1].windows = []
  state.status.profiles.push({ name: 'codex-only', harness: 'codex', windows: [] })
  state.status.profiles.push({ name: '../../outside', windows: [] })
  state.write(path.join(state.root, 'status.json'), state.status)
  const view = buildState(state)
  assert.equal(view.liveProfile, 'alpha')
  assert.equal(view.weeklyLimit, 94)
  assert.equal(view.profiles.length, 2)
  assert.equal(view.profiles[1].five, null)
  assert.equal(view.profiles[1].fable, null)
  assert.equal(view.profiles[0].burnFable, null)
  assert.equal(view.automation.daemon.running, null)
  assert.doesNotMatch(JSON.stringify(view), /SYNTHETIC_SECRET|SYNTHETIC_ACCESS|refreshToken|accessToken/)
})

test('future timestamps, missing profiles, unsupported schema and missing state are explicit', t => {
  const state = fixture(t)
  state.status.generated_at = new Date(Date.now() + 600000).toISOString()
  state.status.profiles.pop()
  state.write(path.join(state.root, 'status.json'), state.status)
  let view = buildState(state)
  assert.equal(view.daemonUp, false)
  assert.deepEqual(view.missingProfiles, ['beta'])
  state.status.schema = 99
  state.write(path.join(state.root, 'status.json'), state.status)
  view = buildState(state)
  assert.equal(view.ok, false)
  assert.equal(view.unsupportedSchema, true)
  assert.deepEqual(view.profiles, [])
  fs.unlinkSync(path.join(state.root, 'status.json'))
  assert.equal(buildState(state).generatedAt, null)
})

test('health identifies the service and only explicit UI assets are served', async t => {
  const app = await start(t)
  assert.deepEqual((await app.request('/api/health')).json, { ok: true, app: 'clauth-workstation', version: '1.0.0' })
  const page = await app.request('/')
  assert.equal(page.status, 200)
  assert.equal(page.headers['x-frame-options'], 'DENY')
  assert.match(page.data, /id="action-status"/)
  for (const url of ['/monitor.mjs', '/server.mjs', '/app.html.bak', '/credentials.json', '/../monitor.mjs']) {
    assert.equal((await app.request(url)).status, 404, url)
  }
})

test('mutations require exact local Host, matching Origin, CSRF and JSON', async t => {
  let called = 0
  const app = await start(t, { switchProfile: async () => { called++; return { ok: true } } })
  assert.equal((await app.request('/api/state', { headers: { Host: 'attacker.invalid' } })).status, 403)
  assert.equal((await app.request('/api/session', { headers: { Origin: 'https://attacker.invalid' } })).status, 403)
  assert.equal((await app.request('/api/switch')).status, 405)
  assert.equal((await app.mutation('/api/switch', { to: 'beta' }, { headers: { Origin: '' } })).status, 403)
  assert.equal((await app.mutation('/api/switch', { to: 'beta' }, { headers: { Origin: app.origin + '.attacker.invalid' } })).status, 403)
  assert.equal((await app.mutation('/api/switch', { to: 'beta' }, { headers: { 'X-Clauth-CSRF': 'wrong' } })).status, 403)
  assert.equal((await app.mutation('/api/switch', { to: 'beta' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  assert.equal(called, 0)
  assert.equal((await app.mutation('/api/switch', { to: 'beta' })).status, 200)
  assert.equal(called, 1)
})

test('body bounds and profile traversal are rejected before executing any action', async t => {
  let called = 0
  const app = await start(t, { switchProfile: async () => { called++; return { ok: true } } })
  assert.equal((await app.mutation('/api/switch', { to: '../alpha' })).status, 400)
  assert.equal((await app.mutation('/api/switch', { to: 'absent' })).status, 404)
  assert.equal((await app.mutation('/api/switch', {}, { body: 'invalid JSON' })).status, 400)
  assert.equal((await app.mutation('/api/switch', { to: 'alpha', padding: 'x'.repeat(5000) })).status, 413)
  assert.equal(called, 0)
})

test('read-only monitor blocks mutations and callback failures cannot leak diagnostics', async t => {
  const readOnly = await start(t, { readOnly: true, ensureDaemon: () => assert.fail('must not run') })
  assert.equal((await readOnly.mutation('/api/daemon-start')).status, 403)
  const app = await start(t, { switchProfile: () => ({ ok: false, error: 'TOKEN_SECRET', out: 'TOKEN_SECRET' }),
    ensureDaemon: () => { throw new Error('PRIVATE_PATH_SECRET') },
    automationState: () => ({ daemon: { running: true, pid: 123 }, heal: { status: 'engine-managed', message: 'TOKEN_SECRET' }, events: ['TOKEN_SECRET'] }) })
  const failed = await app.mutation('/api/switch', { to: 'beta' })
  assert.equal(failed.status, 409)
  assert.deepEqual(failed.json, { ok: false, to: 'beta', error: 'switch_failed' })
  assert.doesNotMatch((await app.mutation('/api/daemon-start')).data, /PRIVATE_PATH_SECRET/)
  const status = await app.request('/api/state')
  assert.equal(status.json.automation.daemon.running, true)
  assert.equal(status.json.automation.heal.status, 'engine-managed')
  assert.doesNotMatch(status.data, /TOKEN_SECRET/)
})

test('switch and daemon actions execute in one serialized queue', async t => {
  let release, started
  const began = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const events = []
  const app = await start(t, { switchProfile: async name => { events.push('switch ' + name); started(); await gate; events.push('switch done'); return { ok: true } },
    ensureDaemon: async () => { events.push('daemon'); return { ok: true } } })
  const first = app.mutation('/api/switch', { to: 'beta' })
  await began
  const second = app.mutation('/api/daemon-start')
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.deepEqual(events, ['switch beta'])
  release()
  const results = await Promise.all([first, second])
  assert.ok(results.every(result => result.status === 200))
  assert.deepEqual(events, ['switch beta', 'switch done', 'daemon'])
})

test('dashboard escapes account data and displays exhaustion, missing values and first-run guidance', t => {
  const state = fixture(t)
  const nodes = new Map()
  const get = selector => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector) }
  const context = vm.createContext({ document: { querySelector: get, addEventListener() {} },
    fetch: () => new Promise(() => {}), setInterval() {}, Date, Intl, console })
  const html = fs.readFileSync(new URL('../src/app.html', import.meta.url), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  vm.runInContext(script, context)
  const view = buildState(state)
  for (const profile of view.profiles) profile.five = 100
  context.state = view
  vm.runInContext('render(state)', context)
  assert.doesNotMatch(get('#grid').innerHTML, /<img/)
  assert.match(get('#grid').innerHTML, /&lt;img/)
  assert.match(get('#alerts').innerHTML, /전환 계정 소진/)
  view.profiles[0].fable = null
  vm.runInContext('render(state)', context)
  assert.match(get('#grid').innerHTML, /미확인/)
  view.profiles = []
  vm.runInContext('render(state)', context)
  assert.match(get('#alerts').innerHTML, /clauth login/)
})
