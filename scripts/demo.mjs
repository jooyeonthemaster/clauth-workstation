#!/usr/bin/env node
// Visual QA only. Every file and account below is generated synthetic data.
// No user home, existing clauth files, OAuth service or daemon is accessed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMonitor } from '../src/monitor.mjs'

const temporaryParent = fs.realpathSync(os.tmpdir())
const directory = fs.mkdtempSync(path.join(temporaryParent, 'clauth-workstation-demo-'))
const root = path.join(directory, 'state')
const livePath = path.join(directory, 'synthetic-live.json')
fs.mkdirSync(path.join(root, 'profiles'), { recursive: true })
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
const names = ['demo-primary', 'demo-spare', 'demo-reserve']
const after = hours => new Date(Date.now() + hours * 3600000).toISOString()
const percentages = [[42, 73, 92], [18, 29, 38], [null, null, null]]

fs.writeFileSync(path.join(root, 'profiles.toml'), 'active_profile = "demo-primary"\nfallback_chain = ["demo-primary", "demo-spare", "demo-reserve"]\nweekly_switch_threshold = 98\n')
writeJson(path.join(root, 'account-emails.json'), {
  'demo-uuid-0': 'primary@example.invalid',
  'demo-uuid-1': 'spare@example.invalid',
  'demo-uuid-2': 'reserve@example.invalid',
})
for (const [index, name] of names.entries()) {
  const profile = path.join(root, 'profiles', name)
  fs.mkdirSync(profile)
  // Plain fake fixture strings; they cannot authenticate anywhere.
  writeJson(path.join(profile, 'credentials.json'), { claudeAiOauth: { refreshToken: 'synthetic-demo-only-' + index } })
  writeJson(path.join(profile, 'account_id.json'), 'demo-uuid-' + index)
  fs.writeFileSync(path.join(profile, 'config.toml'), 'check_scoped = true\nfallback_threshold = 85\n' + (index === 2 ? 'last_resort = true\n' : ''))
  if (index < 2) {
    const history = Array.from({ length: 24 }, (_, sample) => ({
      ts: Date.now() - (23 - sample) * 60000,
      usage: {
        five_hour: { utilization: percentages[index][0] - (23 - sample) * (index ? 0 : 0.35) },
        seven_day: { utilization: percentages[index][1] },
        weekly_scoped: [{ label: '7d fable', utilization: percentages[index][2] - (23 - sample) * (index ? 0 : 0.4) }],
      },
    })).map(row => JSON.stringify(row)).join('\n')
    fs.writeFileSync(path.join(profile, 'usage_history.jsonl'), history + '\n')
  }
}
writeJson(livePath, { claudeAiOauth: { refreshToken: 'synthetic-demo-only-0' } })
const status = {
  schema: 2, clauth_version: '0.17.0', generated_at: new Date().toISOString(), refresh_interval_ms: 90000,
  profiles: names.map((name, index) => ({
    name, harness: 'claude', auth_status: index === 2 ? 'expired' : 'ok', tier: index === 2 ? 'Pro' : 'Max', stale: index === 2,
    fallback: { threshold: 85 },
    windows: index === 2 ? [] : [
      { label: '5h', utilization_pct: percentages[index][0], resets_at: after(index ? 4 : 1.5) },
      { label: '7d', utilization_pct: percentages[index][1], resets_at: after(index ? 70 : 12) },
      { label: '7d fable', utilization_pct: percentages[index][2], resets_at: after(index ? 48 : 5) },
    ],
  })),
}
writeJson(path.join(root, 'status.json'), status)

const server = createMonitor({
  root, livePath, stateDir: directory, port: 47823, readOnly: true,
  automationState: () => ({
    daemon: { running: true, pid: null },
    watchdog: { task: 'synthetic-demo-watchdog', installed: true, enabled: true, running: false, lastResult: 0 },
    heal: { task: 'native-clauth-healing', installed: true, enabled: false, status: 'engine-managed' },
    sync: { installed: true, enabled: false, status: 'engine-managed' },
  }),
})
const refresh = setInterval(() => {
  status.generated_at = new Date().toISOString()
  writeJson(path.join(root, 'status.json'), status)
}, 15000)

function cleanFiles() {
  // Recursive deletion is confined to the exact temporary directory we made.
  if (path.dirname(directory) !== temporaryParent || !path.basename(directory).startsWith('clauth-workstation-demo-')) return
  fs.rmSync(directory, { recursive: true, force: true })
}
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  clearInterval(refresh)
  server.closeAllConnections()
  server.close(() => { cleanFiles(); process.exit(code) })
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
process.on('exit', cleanFiles)
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Demo port 47823 is already in use.' : 'Could not start the isolated demo.')
  clearInterval(refresh)
  cleanFiles()
  process.exitCode = 1
})
server.listen(47823, '127.0.0.1', () => {
  console.log('Synthetic, read-only monitor demo: http://127.0.0.1:47823/')
  console.log('Uses only temporary example.invalid accounts. Press Ctrl+C to stop and remove fixtures.')
})
