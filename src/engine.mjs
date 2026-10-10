import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ENGINE_VERSION, RELEASES } from './config.mjs';

export function verifiedEngine(exe, platform = process.platform, arch = process.arch) {
  const release = RELEASES[`${platform}-${arch}`];
  if (!release || !fs.existsSync(exe)) return false;
  return createHash('sha256').update(fs.readFileSync(exe)).digest('hex') === release.sha256;
}

export async function installEngine(config) {
  const release = RELEASES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`Supported: Windows x64, macOS Apple Silicon/Intel. This host: ${process.platform}/${process.arch}`);
  if (verifiedEngine(config.exe)) return { installed: false, version: ENGINE_VERSION };
  if (fs.existsSync(config.exe)) throw new Error('An unexpected binary already exists in the private engine directory. Refusing to replace it.');
  const url = `https://github.com/uwuclxdy/clauth/releases/download/v${ENGINE_VERSION}/${release.name}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Engine download failed (${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(data).digest('hex') !== release.sha256) throw new Error('Engine checksum mismatch; nothing installed');
  fs.mkdirSync(path.dirname(config.exe), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.exe, data, { mode: 0o700, flag: 'wx' });
  return { installed: true, version: ENGINE_VERSION };
}

export function engineEnvironment(command, inherited = process.env) {
  const env = { ...inherited, CLAUTH_NO_UPDATE: '1', CLAUTH_NO_COMPLETIONS: '1', NO_COMPLETIONS: '1' };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  if (command === 'start') {
    for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      if (env[key] && env[key] !== '0') throw new Error(`${key} overrides profile authentication. Unset it in this terminal before starting an OAuth fallback session.`);
    }
  }
  return env;
}

export function runEngine(config, args, { capture = false, timeout = 0 } = {}) {
  if (!verifiedEngine(config.exe)) throw new Error('Pinned engine missing or changed. Run setup first.');
  const env = engineEnvironment(args[0]);
  const result = spawnSync(config.exe, args, {
    env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', windowsHide: capture,
    ...(timeout ? { timeout } : {})
  });
  if (result.error || result.status !== 0) throw new Error(`clauth ${args[0] || ''} failed${result.signal ? ` (${result.signal})` : ''}`);
  return result.stdout || '';
}

export function requireOffline(config, { holdingMaintenanceLease = false } = {}) {
  if (!verifiedEngine(config.exe)) throw new Error('Pinned engine missing or changed');
  if (!holdingMaintenanceLease && fs.existsSync(path.join(config.stateDir, 'companion.lock'))) throw new Error('Stop the companion before registering accounts or changing policy');
  // The TUI also writes account/configuration state without being a daemon.
  const processes = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='clauth.exe'\" -ErrorAction Stop | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    : spawnSync('pgrep', ['-x', 'clauth'], { encoding: 'utf8', timeout: 15000 });
  const clear = process.platform === 'win32'
    ? !processes.error && processes.status === 0 && ['', '[]', 'null'].includes(processes.stdout.trim())
    : !processes.error && processes.status === 1;
  if (!clear) throw new Error('Close the clauth TUI, sessions and daemon before changing policy. Process state must be verifiably idle.');
  const r = spawnSync(config.exe, ['daemon', '--status'], {
    env: { ...process.env, CLAUTH_NO_UPDATE: '1', CLAUTH_NO_COMPLETIONS: '1' },
    input: 'n\n', encoding: 'utf8', windowsHide: true, timeout: 15000
  });
  const output = `${r.stdout || ''}\n${r.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  if (!r.error && r.status === 1 && /no clauth daemon is running/i.test(output)) return;
  throw new Error('Policy editing requires the companion and clauth daemon to be stopped. Stop the daemon from its TUI controls, then close the TUI and retry.');
}
