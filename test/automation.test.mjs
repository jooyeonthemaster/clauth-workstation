import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutomation, planChainReorder } from '../src/automation.mjs';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const success = stdout => ({ code: 0, stdout, stderr: '' });
const absent = () => ({ code: 1, stdout: '', stderr: 'Error: no clauth daemon is running\n' });
const config = (active = 'acc1') => `active_profile = "${active}"\nunchanged = "keep me"\nfallback_chain = [\n  "acc1",\n  "acc2",\n]\n`;
const cred = name => JSON.stringify({ claudeAiOauth: {
  accessToken: `FAKE-ACCESS-${name}`, refreshToken: `FAKE-REFRESH-${name}`, expiresAt: NOW + 100_000,
} });
const status = () => ({
  generated_at: new Date(NOW).toISOString(),
  profiles: [
    { name: 'acc1', windows: [{ label: '7d', utilization_pct: 20, resets_at: new Date(NOW + 200_000).toISOString() }] },
    { name: 'acc2', windows: [{ label: '7d', utilization_pct: 50, resets_at: new Date(NOW + 100_000).toISOString() }] },
  ],
});

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'clauth-automation-test-'));
  t.after(async () => {
    assert.equal(path.dirname(base), os.tmpdir());
    assert.ok(path.basename(base).startsWith('clauth-automation-test-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'clauth');
  const livePath = path.join(base, 'live.json');
  const stateDir = path.join(base, 'companion');
  const exe = path.join(base, 'bin', 'clauth.exe');
  for (const name of ['acc1', 'acc2']) {
    await fs.mkdir(path.join(root, 'profiles', name), { recursive: true });
    await fs.writeFile(path.join(root, 'profiles', name, 'credentials.json'), cred(name));
  }
  await fs.writeFile(livePath, cred('acc1'));
  await fs.writeFile(path.join(root, 'profiles.toml'), config());
  await fs.writeFile(path.join(root, 'status.json'), JSON.stringify(status()));
  const calls = [];
  const runCommand = async (file, args, commandOptions) => {
    calls.push({ file, args, options: commandOptions });
    if (options.command) {
      const intercepted = await options.command(file, args, commandOptions, { root, livePath, exe });
      if (intercepted !== undefined) return intercepted;
    }
    if (args.join(' ') === '--version') return success('clauth 0.17.0\n');
    if (args.join(' ') === 'daemon --status') return success('running (pid 321, feed fresh)\n');
    if (args.join(' ') === 'which --json') {
      const toml = await fs.readFile(path.join(root, 'profiles.toml'), 'utf8');
      const profile = /active_profile = "([^"]+)"/.exec(toml)?.[1];
      return success(JSON.stringify({ profile, active: true, source: 'refresh_match' }));
    }
    if (args[0] === 'switch') {
      await fs.writeFile(path.join(root, 'profiles.toml'), config(args[1]));
      await fs.writeFile(livePath, cred(args[1]));
      return success('switched\n');
    }
    throw new Error('Unexpected test command');
  };
  const automation = createAutomation({ root, livePath, stateDir, exe, platform: options.platform ?? 'win32', dependencies: {
    now: options.now ?? (() => NOW),
    runCommand,
    probeProcesses: options.probe ?? (async () => ({ known: true, daemons: [{ pid: 321, executable: exe, commandLine: `"${exe}" daemon` }] })),
    spawnDaemon: options.spawn ?? (() => { throw new Error('Unexpected daemon launch'); }),
    sleep: async () => {},
    beforeReplace: options.beforeReplace ? () => options.beforeReplace({ root, livePath }) : undefined,
  } });
  return { automation, root, livePath, stateDir, exe, calls };
}

test('ordering preserves membership, ignores 5h, and orders weekly reset then headroom', () => {
  const toml = 'active_profile = "reserve"\nfallback_chain = ["reserve", "later", "high", "low"]\nother = true\n';
  const plan = planChainReorder(toml, { generated_at: new Date(NOW).toISOString(), profiles: [
    { name: 'reserve', windows: [] },
    { name: 'later', windows: [{ label: '7d', resets_at: new Date(NOW + 2_000).toISOString(), utilization_pct: 0 }] },
    { name: 'high', windows: [{ label: '7d', resets_at: new Date(NOW + 1_000).toISOString(), utilization_pct: 70 }] },
    { name: 'low', windows: [
      { label: '5h', resets_at: new Date(NOW).toISOString(), utilization_pct: 100 },
      { label: '7d', resets_at: new Date(NOW + 1_000).toISOString(), utilization_pct: 5 },
    ] },
    { name: 'not_in_chain', windows: [{ label: '7d', resets_at: new Date(NOW).toISOString() }] },
  ] }, NOW);
  assert.deepEqual(plan.names, ['low', 'high', 'later', 'reserve']);
  assert.match(plan.toml, /^active_profile = "reserve"/);
  assert.match(plan.toml, /other = true/);
});

test('ordering keeps tied profiles stable and refuses stale/future feeds', () => {
  const toml = 'fallback_chain = ["b", "a"]';
  const feed = { generated_at: new Date(NOW).toISOString(), profiles: [] };
  assert.deepEqual(planChainReorder(toml, feed, NOW).names, ['b', 'a']);
  for (const delta of [-600_001, 1]) {
    assert.equal(planChainReorder(toml, { ...feed, generated_at: new Date(NOW + delta).toISOString() }, NOW).reason, 'status-stale-or-invalid');
  }
  assert.equal(planChainReorder('fallback_chain = ["a", "a"]', feed, NOW).reason, 'chain-unsupported');
});

test('tick supervises daemon and atomically reorders only configuration', async t => {
  const f = await fixture(t);
  const result = await f.automation.tick();
  assert.equal(result.watchdog.ok, true);
  assert.equal(result.reorder.changed, true);
  const toml = await fs.readFile(path.join(f.root, 'profiles.toml'), 'utf8');
  assert.match(toml, /"acc2",\s+"acc1"/);
  assert.match(toml, /unchanged = "keep me"/);
  assert.equal(await fs.readFile(f.livePath, 'utf8'), cred('acc1'));
  assert.equal((await fs.readdir(f.root)).some(name => name.endsWith('.tmp')), false);
  const health = f.automation.state();
  assert.equal(health.daemon.running, true);
  assert.equal(health.heal.status, 'engine-managed');
  assert.equal(health.sync.enabled, false);
  assert.doesNotMatch(JSON.stringify(health), /FAKE-(?:ACCESS|REFRESH)/);
});

test('complete TOML concurrency check preserves unrelated engine edits', async t => {
  const f = await fixture(t, { beforeReplace: async ({ root }) => {
    await fs.writeFile(path.join(root, 'profiles.toml'), config().replace('keep me', 'engine changed this'));
  } });
  const result = await f.automation.tick();
  assert.equal(result.reorder.code, 'configuration-changed');
  assert.match(await fs.readFile(path.join(f.root, 'profiles.toml'), 'utf8'), /engine changed this/);
  assert.equal((await fs.readdir(f.root)).some(name => name.endsWith('.tmp')), false);
});

test('torn and future status files never trigger configuration writes', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'status.json'), '{"generated_at":');
  assert.equal((await f.automation.tick()).reorder.changed, false);
  assert.equal(await fs.readFile(path.join(f.root, 'profiles.toml'), 'utf8'), config());
});

test('watchdog refuses unknown lock errors and does not reorder', async t => {
  let launches = 0;
  const f = await fixture(t, {
    command: async (_file, args) => args.join(' ') === 'daemon --status'
      ? { code: 1, stdout: '', stderr: 'Error: permission denied reading lock\n' } : undefined,
    spawn: async () => { launches++; },
  });
  const result = await f.automation.tick();
  assert.equal(result.watchdog.code, 'daemon-status-unknown');
  assert.equal(result.reorder.code, 'daemon-unverified');
  assert.equal(launches, 0);
  assert.equal(f.automation.state().daemon.running, null);
});

test('watchdog never starts beside an older or foreign daemon', async t => {
  let launches = 0;
  const f = await fixture(t, {
    probe: async () => ({ known: true, daemons: [{ pid: 42, executable: path.join(os.tmpdir(), 'older', 'clauth.exe'), commandLine: 'clauth daemon' }] }),
    spawn: async () => { launches++; },
  });
  assert.equal((await f.automation.ensureDaemon()).code, 'daemon-conflict');
  assert.equal(launches, 0);
});

test('watchdog distinguishes unknown process probe from a stopped daemon', async t => {
  const f = await fixture(t, { probe: async () => ({ known: false }) });
  assert.equal((await f.automation.ensureDaemon()).code, 'process-query-unknown');
  assert.equal(f.automation.state().daemon.running, null);
});

test('watchdog starts only after absence proof and verifies new process identity', async t => {
  let started = false, launches = 0, executable;
  const f = await fixture(t, {
    command: async (file, args) => {
      executable = file;
      if (args.join(' ') === 'daemon --status') return started ? success('running (pid 555, feed fresh)\n') : absent();
    },
    probe: async () => ({ known: true, daemons: started ? [{ pid: 555, executable, commandLine: 'clauth daemon' }] : [] }),
    spawn: async () => { launches++; started = true; },
  });
  const result = await f.automation.ensureDaemon();
  assert.deepEqual(result, { ok: true, started: true, pid: 555 });
  assert.equal(launches, 1);
});

test('foreign PID-file owner blocks start without terminating that process', async t => {
  let launches = 0;
  const f = await fixture(t, {
    command: async (_file, args) => args.join(' ') === 'daemon --status' ? absent() : undefined,
    probe: async pid => ({ known: true, daemons: [], pidOwner: { pid, executable: 'unrelated-program' } }),
    spawn: async () => { launches++; },
  });
  await fs.writeFile(path.join(f.root, 'clauthd.pid'), '987');
  assert.equal((await f.automation.ensureDaemon()).code, 'daemon-start-unsafe');
  assert.equal(launches, 0);
});

test('unsupported engine is refused before status or launch', async t => {
  const f = await fixture(t, { command: async (_file, args) => args[0] === '--version' ? success('clauth 0.14.0\n') : undefined });
  assert.equal((await f.automation.ensureDaemon()).code, 'engine-version-unsupported');
  assert.deepEqual(f.calls.map(call => call.args), [['--version']]);
});

test('Windows switch preserves an unknown newer live chain', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.livePath, cred('UNKNOWN-NEWER'));
  assert.equal((await f.automation.switchProfile('acc2')).code, 'live-chain-diverged');
  assert.equal(await fs.readFile(f.livePath, 'utf8'), cred('UNKNOWN-NEWER'));
  assert.equal(f.calls.some(call => call.args[0] === 'switch'), false);
});

test('verified switch explicitly declines capture prompts and reports limited proof', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.automation.switchProfile('acc2'), {
    ok: true, profile: 'acc2', verification: 'engine-and-live-file', sessionVerified: false,
  });
  assert.equal(f.calls.find(call => call.args[0] === 'switch').options.input, 'n\n');
  assert.doesNotMatch(JSON.stringify(f.automation.state()), /FAKE-REFRESH/);
});

test('engine cancellation with exit zero is not reported as switch success', async t => {
  const f = await fixture(t, { command: async (_file, args) => args[0] === 'switch' ? success('Aborted.\n') : undefined });
  assert.equal((await f.automation.switchProfile('acc2')).code, 'switch-declined-or-failed');
  assert.equal(await fs.readFile(f.livePath, 'utf8'), cred('acc1'));
});

test('manual switch refuses an unverified older daemon even with matching credentials', async t => {
  const f = await fixture(t, {
    probe: async () => ({ known: true, daemons: [{ pid: 321, executable: path.join(os.tmpdir(), 'old-engine', 'clauth.exe'), commandLine: 'clauth daemon' }] }),
  });
  assert.equal((await f.automation.switchProfile('acc2')).code, 'daemon-unverified');
  assert.equal(f.calls.some(call => call.args[0] === 'switch'), false);
});

test('switch success requires post-switch identity proof, regardless of child exit code', async t => {
  let reads = 0;
  const f = await fixture(t, { command: async (_file, args) => {
    if (args[0] === 'which' && ++reads > 1) return success(JSON.stringify({ profile: null, source: null, active: false }));
  } });
  assert.equal((await f.automation.switchProfile('acc2')).code, 'switch-verification-needed');
});

test('macOS refuses unknown live identity without attempting Keychain repair', async t => {
  const f = await fixture(t, { platform: 'darwin', command: async (_file, args) => args[0] === 'which'
    ? success(JSON.stringify({ profile: null, source: null, active: false })) : undefined });
  assert.equal((await f.automation.switchProfile('acc2')).code, 'live-session-unverified');
  assert.equal(f.calls.some(call => call.args[0] === 'switch'), false);
});

test('macOS delegates verified switching to pinned native engine', async t => {
  const f = await fixture(t, { platform: 'darwin' });
  assert.equal((await f.automation.switchProfile('acc2')).ok, true);
  assert.equal(f.calls.some(call => /security/.test(call.file)), false);
});

test('profile path traversal is rejected before any engine invocation', async t => {
  const f = await fixture(t);
  assert.equal((await f.automation.switchProfile('../outside')).code, 'profile-name-invalid');
  assert.equal(f.calls.length, 0);
});

test('ticks are serialized and obey the watchdog/reorder cadence', async t => {
  let time = NOW;
  const f = await fixture(t, { now: () => time });
  const [first, second] = await Promise.all([f.automation.tick(), f.automation.tick()]);
  assert.deepEqual(Object.keys(first), ['watchdog', 'reorder']);
  assert.deepEqual(second, {});
  time += 180_000;
  assert.deepEqual(Object.keys(await f.automation.tick()), ['watchdog']);
  time += 420_000;
  assert.deepEqual(Object.keys(await f.automation.tick()), ['watchdog', 'reorder']);
});

test('returned health is a copy that cannot mutate internal safety state', async t => {
  const f = await fixture(t);
  const copy = f.automation.state();
  copy.daemon.running = true;
  copy.sync.enabled = true;
  assert.equal(f.automation.state().daemon.running, null);
  assert.equal(f.automation.state().sync.enabled, false);
});

test('old or future daemon checks are not presented as proof of a running process', async t => {
  let time = NOW;
  const f = await fixture(t, { now: () => time });
  await f.automation.ensureDaemon();
  assert.equal(f.automation.state().daemon.running, true);
  time = NOW + 210_001;
  assert.equal(f.automation.state().daemon.running, null);
  time = NOW - 1;
  assert.equal(f.automation.state().daemon.running, null);
});
