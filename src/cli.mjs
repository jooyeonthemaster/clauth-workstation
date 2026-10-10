#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { paths, POLICY, ENGINE_VERSION, REPO, readJson, validName, atomicWrite } from './config.mjs';
import { installEngine, verifiedEngine, runEngine, requireOffline } from './engine.mjs';
import { initialize, isManaged, configure } from './setup.mjs';
import { legacyTasks, installService, uninstallService, installLauncher, openBrowser } from './services.mjs';
import { acquireSupervisorLease } from './lease.mjs';

function print(data) { console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2)); }
function configFromArgs(args) {
  const get = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  return paths({ port: get('--port') || process.env.CLAUTH_MONITOR_PORT || POLICY.monitorPort });
}

export function doctor(config) {
  let tasks = [], taskError = null;
  try { tasks = legacyTasks(); } catch (e) { taskError = e.message; }
  const status = readJson(path.join(config.root, 'status.json'));
  const ageSec = status?.generated_at ? (Date.now() - Date.parse(status.generated_at)) / 1000 : null;
  const liveItem = (() => { try { return fs.lstatSync(config.livePath); } catch { return null; } })();
  let symlinks = false;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clauth-link-probe-'));
  try { fs.writeFileSync(path.join(temp, 'target'), 'probe'); fs.symlinkSync(path.join(temp, 'target'), path.join(temp, 'link'), 'file'); symlinks = true; }
  catch {} finally { fs.rmSync(temp, { recursive: true, force: true }); }
  const report = {
    platform: process.platform, arch: process.arch, node: process.versions.node,
    pinnedEngine: ENGINE_VERSION, engineInstalledAndVerified: verifiedEngine(config.exe),
    managed: isManaged(config), legacyTasks: tasks, taskProbeError: taskError,
    statusFresh: ageSec !== null && ageSec >= 0 && ageSec < 300,
    profileCount: status?.profiles?.filter(p => !p.harness || p.harness === 'claude').length || 0,
    liveStorage: liveItem?.isSymbolicLink() ? 'symlink' : liveItem ? 'regular file' : 'absent (macOS may use Keychain)',
    symlinkSupport: symlinks,
    sessionFallback: symlinks ? 'Use clauth start --with-fallback NAME via this launcher; VS Code follow-through is not verified' : 'Windows Developer Mode/symlink permission is required',
    credentialsShared: false,
    automatedMutationsAllowed: isManaged(config) && verifiedEngine(config.exe) && !tasks.length && !taskError
  };
  return report;
}

function guardManaged(config) {
  if (!isManaged(config)) throw new Error('Unmanaged installation. Read-only monitoring is available; see docs/MIGRATION.md.');
  if (!verifiedEngine(config.exe)) throw new Error('Pinned engine missing or checksum changed.');
  if (legacyTasks().length) throw new Error('Legacy clauth automation is active. Refusing competing token/account writers.');
}

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const j = await r.json();
    return r.ok && j.app === 'clauth-workstation' ? j : null;
  } catch { return null; }
}

async function monitor(config, readOnly) {
  const { createMonitor } = await import('./monitor.mjs');
  let automation, lease;
  if (!readOnly) {
    guardManaged(config);
    const { createAutomation } = await import('./automation.mjs');
    lease = await acquireSupervisorLease(config.stateDir);
    automation = createAutomation(config);
  }
  // Bind first: port collision cannot start another background engine.
  const server = createMonitor({ ...config, readOnly,
    switchProfile: automation ? name => automation.switchProfile(name) : undefined,
    ensureDaemon: automation ? () => automation.ensureDaemon() : undefined,
    automationState: automation ? () => automation.state() : undefined
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve);
    });
  } catch (error) { await lease?.release(); throw error; }
  let timer;
  if (automation) {
    await automation.tick();
    timer = setInterval(() => automation.tick().catch(() => console.error('Automation tick failed; see dashboard status')), 30000);
  }
  print(`Clauth monitor: http://127.0.0.1:${config.port}/ (${readOnly ? 'read-only' : 'managed'})`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    if (timer) clearInterval(timer);
    server.close(async () => { await lease?.release(); process.exit(0); });
    setTimeout(() => process.exit(0), 2000).unref();
  });
  return server;
}

async function open(config) {
  if (!await health(config.port)) {
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    const log = fs.openSync(path.join(config.stateDir, 'monitor-launch.log'), 'a', 0o600);
    const mode = isManaged(config) ? ['serve'] : ['monitor', '--read-only'];
    const child = spawn(process.execPath, [path.join(REPO, 'src', 'cli.mjs'), ...mode, '--port', String(config.port)], {
      detached: true, stdio: ['ignore', log, log], windowsHide: true
    });
    fs.closeSync(log);
    child.on('error', () => {}); child.unref();
    for (let i = 0; i < 20 && !await health(config.port); i++) await delay(250);
  }
  if (!await health(config.port)) throw new Error('Monitor did not start. The port may be occupied by the legacy monitor.');
  openBrowser(`http://127.0.0.1:${config.port}/`);
}

export async function main(args = process.argv.slice(2)) {
  const [command = 'help', name] = args;
  const config = configFromArgs(args);
  switch (command) {
    case 'doctor': return print(doctor(config));
    case 'setup': {
      if (legacyTasks().length) throw new Error('Existing clauth tasks detected. Current environment was not changed. Use npm run monitor -- --port 47822.');
      if (!isManaged(config) && (fs.existsSync(path.join(config.root, 'profiles.toml')) || fs.existsSync(path.join(config.root, 'profiles')))) {
        throw new Error('Existing clauth installation. Setup leaves it unchanged; see docs/MIGRATION.md.');
      }
      print(await installEngine(config));
      initialize(config);
      print({ ready: true, launcher: installLauncher(config), next: 'node src/cli.mjs login main' });
      return;
    }
    case 'login': {
      guardManaged(config);
      requireOffline(config);
      if (!validName(name)) throw new Error('Provide a profile name, for example: login main');
      const lease = await acquireSupervisorLease(config.stateDir);
      try {
        requireOffline(config, { holdingMaintenanceLease: true });
        runEngine(config, ['login', name]);
        requireOffline(config, { holdingMaintenanceLease: true });
        print(configure(config));
      } finally { await lease.release(); }
      print('Check the browser-approved account email. Authenticate every computer separately; do not copy tokens.');
      return;
    }
    case 'configure': {
      guardManaged(config); requireOffline(config);
      const lease = await acquireSupervisorLease(config.stateDir);
      try { requireOffline(config, { holdingMaintenanceLease: true }); print(configure(config)); }
      finally { await lease.release(); }
      return;
    }
    case 'service': {
      if (name === 'install') { guardManaged(config); return print({ service: installService(config), installed: true }); }
      if (name === 'uninstall') { uninstallService(); return print('Companion startup removed. Account data is preserved; a native daemon may still be running.'); }
      throw new Error('Use service install or service uninstall');
    }
    case 'start': {
      guardManaged(config);
      if (!validName(name)) throw new Error('Provide a profile name: start main');
      const { createAutomation } = await import('./automation.mjs');
      const started = await createAutomation(config).ensureDaemon();
      if (!started.ok) throw new Error(started.message || started.error || 'Daemon is not ready');
      const divider = args.indexOf('--');
      return runEngine(config, ['start', '--with-fallback', name, ...(divider >= 0 ? ['--', ...args.slice(divider + 1)] : [])]);
    }
    case 'switch': {
      guardManaged(config);
      if (!validName(name)) throw new Error('Provide a profile name');
      const { createAutomation } = await import('./automation.mjs');
      if (await health(config.port)) throw new Error('The monitor is running. Use its 기본 계정 전환 button to serialize this action with background work.');
      const lease = await acquireSupervisorLease(config.stateDir);
      try {
        const result = await createAutomation(config).switchProfile(name);
        if (!result.ok) throw new Error(result.message || result.error || 'Switch refused');
        return print(result);
      } finally { await lease.release(); }
    }
    case 'monitor': return monitor(config, true);
    case 'serve': return monitor(config, false);
    case 'open': return open(config);
    default: return print(`Clauth Workstation\n\nsetup                 Install pinned engine + monitor shortcut on a fresh workstation\nlogin NAME            Authenticate one account on THIS computer and apply policy\nconfigure             Apply policy to registered accounts\ndoctor                Inspect local installation without changing account configuration\nmonitor [--port N]    Read-only dashboard (safe beside legacy setup)\nserve                 Managed monitor + daemon supervision\nservice install       Start managed service now and at user login\nservice uninstall     Remove companion startup only\nstart NAME -- ARGS     Launch terminal Claude following fallback chain\nswitch NAME           Guarded manual account switch\nopen [--port N]       Open monitor in the default browser\n\nExisting installations: read docs/MIGRATION.md. Real VS Code and macOS account switching still needs acceptance testing.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
