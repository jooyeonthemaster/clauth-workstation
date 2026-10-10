import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const POLICY = JSON.parse(fs.readFileSync(path.join(REPO, 'config/workstation.json'), 'utf8'));
export const ENGINE_VERSION = '0.17.0';
export const RELEASES = {
  'win32-x64': { name: 'clauth-windows-x86_64.exe', sha256: '32891bf3d5173c1425b9b536ca3aec54a49ec2d6d0d36493f4a96170aabcea59' },
  'darwin-arm64': { name: 'clauth-macos-aarch64', sha256: 'ec467b7c8228774149f747502ea9ba9fb62bd925c7b6506cd9e5fa556916d806' },
  'darwin-x64': { name: 'clauth-macos-x86_64', sha256: 'b996cdbc6772dc1a8b3b6bc19477320dd97b0b1850d11aad4c42b3acf5c2caf8' }
};

export function paths({ home = os.homedir(), stateDir, port = POLICY.monitorPort } = {}) {
  const state = path.resolve(stateDir || path.join(home, '.clauth-workstation'));
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('Invalid monitor port');
  return {
    home, root: path.join(home, '.clauth'), livePath: path.join(home, '.claude', '.credentials.json'),
    stateDir: state, exe: path.join(state, 'bin', process.platform === 'win32' ? 'clauth.exe' : 'clauth'), port: number
  };
}

export function validName(name) { return typeof name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(name); }
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

export function atomicWrite(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, text, { mode, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}

// Only top-level scalar/array policy keys are replaced. Reject table-scoped
// duplicates instead of accidentally editing unrelated engine configuration.
export function replaceTopLevel(toml, key, value) {
  const section = toml.search(/^[ \t]*\[/m);
  const top = section < 0 ? toml : toml.slice(0, section);
  const rest = section < 0 ? '' : toml.slice(section);
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(?:\\[[\\s\\S]*?\\]|[^\\r\\n]*)`, 'gm');
  const matches = [...top.matchAll(re)];
  if (matches.length > 1) throw new Error(`Duplicate configuration key: ${key}`);
  const line = `${key} = ${value}`;
  return (matches.length ? top.replace(re, () => line) : `${line}\n${top}`) + rest;
}
