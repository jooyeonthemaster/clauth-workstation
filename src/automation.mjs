import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const ENGINE_VERSION = '0.17.0';
const CADENCE = { watchdog: 180_000, reorder: 600_000 };
const PROFILE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (text = '') => text.replace(ANSI, '').trim();
const task = (name, enabled = true, status = 'pending') => ({
  task: name, installed: true, enabled, running: false, lastRun: null,
  lastResult: null, scriptMissing: false, status,
});

function globalEnvironment() {
  const env = { ...process.env };
  // A terminal's isolated session must not redirect global status/switch checks.
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  env.CLAUTH_NO_UPDATE = '1';
  env.CLAUTH_NO_COMPLETIONS = '1';
  return env;
}

function runCommand(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true, shell: false, env: globalEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill(); // Only the short-lived child created by this call.
      finish(Object.assign(new Error('Command timed out'), { code: 'COMMAND_TIMEOUT' }));
    }, options.timeout ?? 15_000);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65_536); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65_536); });
    child.on('error', error => finish(error));
    child.on('close', code => finish(null, { code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

function sameExecutable(actual, expected, platform) {
  if (!actual) return false;
  const normalize = value => {
    const full = path.resolve(value);
    return platform === 'win32' ? full.toLowerCase() : full;
  };
  return normalize(actual) === normalize(expected);
}

function isDaemon(command = '') {
  return /(?:^|\s)daemon(?:\s|$)/.test(command) &&
    !/(?:^|\s)--(?:status|stop)(?:\s|$)/.test(command);
}

async function probeProcesses(platform, pid, command) {
  try {
    let records;
    if (platform === 'win32') {
      const filter = "Name='clauth.exe'" + (pid ? ` OR ProcessId=${pid}` : '');
      const script = `@(Get-CimInstance Win32_Process -Filter \"${filter}\" -ErrorAction Stop | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress`;
      const result = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
      if (result.code !== 0) return { known: false };
      const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
      records = (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({
        pid: Number(p.ProcessId), executable: p.ExecutablePath, commandLine: p.CommandLine,
      }));
      if (records.some(p => !p.executable || !p.commandLine || !Number.isSafeInteger(p.pid))) return { known: false };
    } else {
      const result = await command('ps', ['-ax', '-o', 'pid=,args=']);
      if (result.code !== 0) return { known: false };
      const candidates = result.stdout.split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line))
        .filter(Boolean).map(m => ({ pid: Number(m[1]), commandLine: m[2] }))
        .filter(p => p.pid === pid || /(?:^|[\s/])clauth(?:\s|$)/.test(p.commandLine));
      records = [];
      for (const p of candidates) {
        const executable = await command('ps', ['-p', String(p.pid), '-o', 'comm=']);
        if (executable.code !== 0 || !executable.stdout.trim()) return { known: false };
        records.push({ ...p, executable: executable.stdout.trim() });
      }
    }
    return {
      known: true,
      daemons: records.filter(p => isDaemon(p.commandLine)),
      pidOwner: records.find(p => p.pid === pid) ?? null,
    };
  } catch {
    return { known: false };
  }
}

function parseActive(toml) {
  return /^active_profile\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?$/m.exec(toml)?.[1] ?? null;
}

function chainBlock(toml) {
  const match = /^fallback_chain\s*=\s*\[([^\]]*)\]/m.exec(toml);
  if (!match) return null;
  // Only support the engine's canonical string array. Refuse unusual TOML
  // rather than silently losing comments/values while rewriting it.
  const body = match[1].replace(/#.*$/gm, '');
  const names = [];
  let rest = body.trim();
  while (rest) {
    const item = /^"([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})"\s*(,|$)/.exec(rest);
    if (!item) return null;
    names.push(item[1]);
    rest = rest.slice(item[0].length).trim();
  }
  if (new Set(names).size !== names.length) return null;
  return { match, names };
}

/** Pure ordering policy; no credentials, writes or network calls. */
export function planChainReorder(toml, status, now = Date.now()) {
  const generated = Date.parse(status?.generated_at);
  const age = now - generated;
  if (!Number.isFinite(generated) || age < 0 || age > 600_000) {
    return { changed: false, reason: 'status-stale-or-invalid' };
  }
  if (!Array.isArray(status?.profiles)) return { changed: false, reason: 'status-invalid' };
  const block = chainBlock(toml);
  if (!block) return { changed: false, reason: 'chain-unsupported' };
  const keyed = block.names.map((name, idx) => {
    const profile = status.profiles.find(p => p?.name === name);
    let reset = Infinity, utilization = 0;
    for (const window of Array.isArray(profile?.windows) ? profile.windows : []) {
      if (!window || typeof window !== 'object') continue;
      if (window.label === '5h') continue;
      if (typeof window.utilization_pct === 'number' && Number.isFinite(window.utilization_pct)) {
        utilization = Math.max(utilization, window.utilization_pct);
      }
      const timestamp = Date.parse(window.resets_at);
      if (Number.isFinite(timestamp)) reset = Math.min(reset, timestamp);
    }
    return { name, idx, reset, utilization };
  });
  const names = keyed.sort((a, b) => {
    if (a.reset !== b.reset) return a.reset < b.reset ? -1 : 1;
    return a.utilization - b.utilization || a.idx - b.idx;
  }).map(p => p.name);
  if (names.every((name, i) => name === block.names[i])) {
    return { changed: false, reason: 'already-ordered', names };
  }
  const newline = toml.includes('\r\n') ? '\r\n' : '\n';
  const replacement = `fallback_chain = [${newline}${names.map(n => `    "${n}",`).join(newline)}${newline}]`;
  return {
    changed: true, reason: 'reordered', names,
    toml: toml.slice(0, block.match.index) + replacement + toml.slice(block.match.index + block.match[0].length),
  };
}

/**
 * Supervise a pinned v0.17 engine. Runtime files stay in root/stateDir.
 * dependencies are test seams; production callers should omit them.
 * Native engine refresh/adoption replaces legacy credential-copy helpers.
 */
export function createAutomation({ root, livePath, stateDir, exe, platform = process.platform, dependencies = {} }) {
  if (!root || !livePath || !stateDir || !exe) throw new Error('root, livePath, stateDir and exe are required');
  root = path.resolve(root);
  livePath = path.resolve(livePath);
  stateDir = path.resolve(stateDir);
  exe = path.resolve(exe);
  if (!dependencies.runCommand && !sameExecutable(root, path.join(os.homedir(), '.clauth'), platform)) {
    throw new Error('clauth uses the real user home; a custom root is supported only with injected test commands');
  }
  const now = dependencies.now ?? Date.now;
  const command = dependencies.runCommand ?? runCommand;
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const probe = dependencies.probeProcesses ?? (pid => probeProcesses(platform, pid, command));
  const health = {
    daemon: { running: null, pid: null, message: 'Not checked yet.' },
    watchdog: task('companion-watchdog'),
    heal: { ...task('native-clauth-healing', false, 'engine-managed'), message: 'clauth v0.17 handles session adoption; legacy healing is disabled.' },
    sync: { ...task('native-clauth-sync', false, 'engine-managed'), message: 'clauth v0.17 owns file and Keychain synchronization; companion token copying is disabled.' },
    reorder: task('companion-chain-reorder'),
    events: [],
  };
  const last = { watchdog: null, reorder: null };
  let queue = Promise.resolve();
  const serialize = operation => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  };
  function event(job, status, message, level = 'info') {
    if (health[job]) Object.assign(health[job], { status, message });
    const previous = health.events.at(-1);
    if (previous?.job === job && previous?.message === message) return;
    health.events.push({ at: new Date(now()).toISOString(), level, job, message });
    health.events = health.events.slice(-50);
  }
  const failure = (job, code, message) => {
    event(job, code, message, 'warn');
    return { ok: false, code, message };
  };
  async function engineReady(job) {
    try {
      const result = await command(exe, ['--version']);
      if (result.code === 0 && strip(result.stdout) === `clauth ${ENGINE_VERSION}`) return true;
    } catch {}
    failure(job, 'engine-version-unsupported', `The pinned clauth ${ENGINE_VERSION} executable is required.`);
    return false;
  }
  async function readPid() {
    try {
      const text = (await fs.readFile(path.join(root, 'clauthd.pid'), 'utf8')).trim();
      return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
    } catch { return null; }
  }
  async function daemonStatus() {
    try {
      const result = await command(exe, ['daemon', '--status']);
      const stdout = strip(result.stdout), stderr = strip(result.stderr);
      const running = /^running \(pid ([1-9]\d*),/.exec(stdout);
      if (result.code === 0 && running && !stderr) return { kind: 'up', pid: Number(running[1]) };
      if (result.code === 1 && !stdout && stderr === 'Error: no clauth daemon is running') return { kind: 'down' };
    } catch {}
    return { kind: 'unknown' };
  }
  async function launch() {
    if (dependencies.spawnDaemon) return dependencies.spawnDaemon(exe);
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const stdout = await fs.open(path.join(stateDir, 'daemon.stdout.log'), 'a', 0o600);
    let stderr;
    try {
      stderr = await fs.open(path.join(stateDir, 'daemon.stderr.log'), 'a', 0o600);
      await new Promise((resolve, reject) => {
        const child = spawn(exe, ['daemon'], {
          windowsHide: true, detached: true, shell: false,
          env: globalEnvironment(), stdio: ['ignore', stdout.fd, stderr.fd],
        });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
    } finally {
      await stdout.close();
      await stderr?.close();
    }
  }
  async function ensureDaemonInternal() {
    health.watchdog.lastRun = new Date(now()).toISOString();
    health.watchdog.running = true;
    try {
      if (!(await engineReady('watchdog'))) {
        health.daemon = { running: null, pid: null, message: 'Engine verification failed.' };
        return { ok: false, code: 'engine-version-unsupported' };
      }
      const status = await daemonStatus();
      if (status.kind === 'unknown') {
        health.daemon = { running: null, pid: null, message: 'Daemon lock status could not be verified.' };
        return failure('watchdog', 'daemon-status-unknown', health.daemon.message);
      }
      const pid = status.pid ?? await readPid();
      const processes = await probe(pid);
      if (!processes?.known) {
        health.daemon = { running: null, pid: null, message: 'Process identity could not be verified.' };
        return failure('watchdog', 'process-query-unknown', health.daemon.message);
      }
      const daemons = processes.daemons ?? [];
      const foreign = daemons.some(p => !sameExecutable(p.executable, exe, platform));
      if (foreign || daemons.length > 1) {
        health.daemon = { running: null, pid: null, message: 'Another clauth daemon must be stopped before enabling this installation.' };
        return failure('watchdog', 'daemon-conflict', health.daemon.message);
      }
      if (status.kind === 'up') {
        const own = daemons.find(p => p.pid === status.pid && sameExecutable(p.executable, exe, platform));
        if (!own) {
          health.daemon = { running: null, pid: null, message: 'The daemon lock and process identity disagree.' };
          return failure('watchdog', 'daemon-identity-unknown', health.daemon.message);
        }
        health.daemon = { running: true, pid: own.pid, message: 'Verified pinned engine daemon.' };
        event('watchdog', 'healthy', health.daemon.message);
        return { ok: true, started: false, pid: own.pid };
      }
      if (daemons.length || processes.pidOwner) {
        health.daemon = { running: null, pid: null, message: 'A process exists without the expected daemon lock; automatic start refused.' };
        return failure('watchdog', 'daemon-start-unsafe', health.daemon.message);
      }
      health.daemon = { running: false, pid: null, message: 'No daemon is running.' };
      await launch();
      for (let attempt = 0; attempt < 10; attempt++) {
        await sleep(1_000);
        const after = await daemonStatus();
        if (after.kind !== 'up') continue;
        const check = await probe(after.pid);
        if (!check?.known) continue;
        const only = check.daemons ?? [];
        if (only.length === 1 && only[0].pid === after.pid && sameExecutable(only[0].executable, exe, platform)) {
          health.daemon = { running: true, pid: after.pid, message: 'Pinned engine daemon started and verified.' };
          event('watchdog', 'healthy', health.daemon.message);
          return { ok: true, started: true, pid: after.pid };
        }
      }
      health.daemon = { running: null, pid: null, message: 'Daemon launch was attempted but could not be verified.' };
      return failure('watchdog', 'daemon-start-unverified', health.daemon.message);
    } catch {
      health.daemon = { running: null, pid: null, message: 'Daemon supervision failed; no existing process was stopped.' };
      return failure('watchdog', 'daemon-check-failed', health.daemon.message);
    } finally {
      health.watchdog.running = false;
      health.watchdog.lastResult = health.watchdog.status === 'healthy' ? 0 : 1;
    }
  }
  async function which() {
    const result = await command(exe, ['which', '--json']);
    if (result.code !== 0) return null;
    try { return JSON.parse(result.stdout); } catch { return null; }
  }
  function matchesProfile(identity, name) {
    return identity?.profile === name && identity.active === true &&
      ['refresh_match', 'session_token_match'].includes(identity.source);
  }
  async function switchDaemonCompatible() {
    const status = await daemonStatus();
    if (status.kind === 'unknown') return false;
    const processes = await probe(status.pid ?? await readPid());
    if (!processes?.known) return false;
    const daemons = processes.daemons ?? [];
    if (daemons.length > 1 || daemons.some(p => !sameExecutable(p.executable, exe, platform))) return false;
    if (status.kind === 'up') return daemons.length === 1 && daemons[0].pid === status.pid;
    return daemons.length === 0 && !processes.pidOwner;
  }
  async function switchInternal(name) {
    if (typeof name !== 'string' || !PROFILE.test(name)) {
      return failure('switch', 'profile-name-invalid', 'Choose a profile with a supported name.');
    }
    if (!(await engineReady('switch'))) return { ok: false, code: 'engine-version-unsupported' };
    try {
      if (!(await switchDaemonCompatible())) {
        return failure('switch', 'daemon-unverified', 'The running daemon could not be verified as this installation; switching refused.');
      }
      const tomlPath = path.join(root, 'profiles.toml');
      const before = await fs.readFile(tomlPath, 'utf8');
      const active = parseActive(before);
      if (!active || !PROFILE.test(active)) return failure('switch', 'active-profile-unknown', 'The active profile could not be verified.');
      const target = await fs.stat(path.join(root, 'profiles', name));
      if (!target.isDirectory()) return failure('switch', 'profile-not-found', 'The requested profile does not exist.');
      if (!matchesProfile(await which(), active)) {
        return failure('switch', 'live-session-unverified', 'Live credentials do not match the active profile. Let the engine adopt the session before switching.');
      }
      if (platform === 'win32') {
        const liveBytes = await fs.readFile(livePath, 'utf8');
        const snapshotPath = path.join(root, 'profiles', active, 'credentials.json');
        const snapshotBytes = await fs.readFile(snapshotPath, 'utf8');
        const live = JSON.parse(liveBytes)?.claudeAiOauth;
        const snapshot = JSON.parse(snapshotBytes)?.claudeAiOauth;
        if (!live?.refreshToken || live.refreshToken !== snapshot?.refreshToken) {
          return failure('switch', 'live-chain-diverged', 'The live token chain differs; companion will not overwrite or restore credentials.');
        }
        if (await fs.readFile(livePath, 'utf8') !== liveBytes || await fs.readFile(snapshotPath, 'utf8') !== snapshotBytes) {
          return failure('switch', 'credentials-changed', 'Credentials changed during verification; retry after the engine settles.');
        }
      } else if (platform !== 'darwin' && platform !== 'linux') {
        return failure('switch', 'platform-unsupported', 'This platform has not been validated.');
      }
      if (await fs.readFile(tomlPath, 'utf8') !== before) {
        return failure('switch', 'configuration-changed', 'The active configuration changed during verification; retry.');
      }
      // Upstream defaults an empty confirmation/EOF to YES. Explicitly answer
      // no if a race produces its newer-login capture prompt. Never restore a
      // snapshot or write a token ourselves.
      const result = await command(exe, ['switch', name], { input: 'n\n', timeout: 60_000 });
      if (result.code !== 0 || /\babort(?:ed)?\b/i.test(result.stdout + result.stderr)) {
        return failure('switch', 'switch-declined-or-failed', 'The engine declined or failed the switch; credentials were not restored by the companion.');
      }
      const after = await fs.readFile(tomlPath, 'utf8');
      if (parseActive(after) !== name || !matchesProfile(await which(), name)) {
        return failure('switch', 'switch-verification-needed', 'The switch could not be verified against the engine and live file. Check the current Claude session.');
      }
      event('switch', 'verified', 'The selected profile matches the engine and live credential file.');
      return { ok: true, profile: name, verification: 'engine-and-live-file', sessionVerified: false };
    } catch {
      return failure('switch', 'switch-verification-failed', 'Required profile or credential state could not be read; automatic switching refused.');
    }
  }
  async function reorderInternal() {
    const job = health.reorder;
    job.lastRun = new Date(now()).toISOString();
    job.running = true;
    let temp;
    try {
      const tomlPath = path.join(root, 'profiles.toml');
      const info = await fs.lstat(tomlPath);
      if (!info.isFile() || info.isSymbolicLink()) return failure('reorder', 'configuration-unsupported', 'Configuration must be a regular file.');
      const original = await fs.readFile(tomlPath, 'utf8');
      let status;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { status = JSON.parse(await fs.readFile(path.join(root, 'status.json'), 'utf8')); break; }
        catch { if (attempt < 2) await sleep(300); }
      }
      const plan = planChainReorder(original, status, now());
      if (!plan.changed) {
        event('reorder', plan.reason, 'Fallback order was left unchanged.');
        return { ok: true, changed: false, code: plan.reason };
      }
      temp = `${tomlPath}.companion-${randomUUID()}.tmp`;
      await fs.writeFile(temp, plan.toml, { encoding: 'utf8', flag: 'wx', mode: info.mode & 0o777 });
      await dependencies.beforeReplace?.();
      const current = await fs.lstat(tomlPath);
      if (!current.isFile() || current.isSymbolicLink() || await fs.readFile(tomlPath, 'utf8') !== original) {
        return failure('reorder', 'configuration-changed', 'Configuration changed during planning; this ordering pass was skipped.');
      }
      await fs.rename(temp, tomlPath);
      temp = null;
      event('reorder', 'reordered', 'Fallback profiles were ordered by weekly reset, then remaining headroom.');
      return { ok: true, changed: true };
    } catch {
      return failure('reorder', 'reorder-unavailable', 'Fallback ordering could not safely read or update the configuration.');
    } finally {
      if (temp) await fs.unlink(temp).catch(() => {});
      job.running = false;
      job.lastResult = ['reorder-unavailable', 'configuration-unsupported', 'configuration-changed'].includes(job.status) ? 1 : 0;
    }
  }
  return {
    ensureDaemon: () => serialize(ensureDaemonInternal),
    switchProfile: name => serialize(() => switchInternal(name)),
    tick: () => serialize(async () => {
      const results = {};
      for (const [job, interval] of Object.entries(CADENCE)) {
        const time = now();
        if (last[job] !== null && time >= last[job] && time - last[job] < interval) continue;
        last[job] = time;
        if (job === 'reorder' && health.daemon.running !== true) {
          results[job] = failure('reorder', 'daemon-unverified', 'Fallback ordering is paused until the pinned daemon is verified.');
          continue;
        }
        results[job] = await (job === 'watchdog' ? ensureDaemonInternal() : reorderInternal());
      }
      return results;
    }),
    state: () => {
      const copy = structuredClone(health);
      const checked = Date.parse(copy.watchdog.lastRun);
      const age = now() - checked;
      if (copy.daemon.running === true && (!Number.isFinite(checked) || age < 0 || age > CADENCE.watchdog + 30_000)) {
        copy.daemon = { running: null, pid: null, message: 'The last daemon identity check is no longer current.' };
      }
      return copy;
    },
  };
}
