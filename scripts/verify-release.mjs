import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ENGINE_VERSION, paths } from '../src/config.mjs';
import { installEngine, verifiedEngine } from '../src/engine.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clauth-release-'));
try {
  const config = paths({ stateDir: temp });
  await installEngine(config);
  if (!verifiedEngine(config.exe)) throw new Error('Release verification failed');
  // --version exits before clauth accesses home/configuration.
  const r = spawnSync(config.exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (r.error || r.status !== 0 || !r.stdout.includes(ENGINE_VERSION)) throw new Error('Release executable did not report expected version');
  console.log(`${process.platform}/${process.arch}: ${r.stdout.trim()}, SHA-256 verified`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
