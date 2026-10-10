import fs from 'node:fs';
import path from 'node:path';
import { POLICY, atomicWrite, readJson, replaceTopLevel, validName } from './config.mjs';

export function isManaged(config) {
  const marker = readJson(path.join(config.stateDir, 'managed-root.json'));
  return marker?.root === path.resolve(config.root);
}

export function initialize(config) {
  if (isManaged(config)) return false;
  const target = path.join(config.root, 'profiles.toml');
  if (fs.existsSync(target) || fs.existsSync(path.join(config.root, 'profiles'))) {
    throw new Error('Existing clauth installation detected. Setup leaves it unchanged; use monitor --read-only. See docs/MIGRATION.md.');
  }
  atomicWrite(target, 'profiles = []\nfallback_chain = []\nwrap_off = false\npreemptive_rotation = false\nrefresh_interval_ms = 90000\nweekly_switch_threshold = 98\n');
  fs.mkdirSync(path.join(config.root, 'profiles'), { recursive: true, mode: 0o700 });
  atomicWrite(path.join(config.stateDir, 'managed-root.json'), JSON.stringify({ root: path.resolve(config.root), createdAt: new Date().toISOString() }));
  return true;
}

export function configure(config, policy = POLICY) {
  if (!isManaged(config)) throw new Error('This clauth installation is not managed by this companion; automatic edits refused');
  const file = path.join(config.root, 'profiles.toml');
  const original = fs.readFileSync(file, 'utf8');
  // Registration is proven by local files, never by copying the example names.
  const roster = /^[ \t]*profiles[ \t]*=[ \t]*\[([^\]]*)\]/m.exec(original);
  if (!roster) throw new Error('Cannot read the engine profile roster');
  let remaining = roster[1].replace(/#.*$/gm, '').trim();
  const registered = [];
  while (remaining) {
    const item = /^(?:"([A-Za-z0-9_-]{1,32})"|'([A-Za-z0-9_-]{1,32})')\s*(?:,|$)/.exec(remaining);
    if (!item) throw new Error('Unsupported profile roster syntax; no configuration changed');
    registered.push(item[1] || item[2]);
    remaining = remaining.slice(item[0].length).trim();
  }
  if (new Set(registered).size !== registered.length) throw new Error('Duplicate profile names; no configuration changed');
  const names = registered.filter(name => validName(name) && fs.existsSync(path.join(config.root, 'profiles', name, 'credentials.json')));
  const chain = [...policy.fallbackOrder.filter(n => names.includes(n)), ...names.filter(n => !policy.fallbackOrder.includes(n))];
  let updated = original;
  for (const [key, value] of Object.entries({
    fallback_chain: JSON.stringify(chain),
    wrap_off: 'false', preemptive_rotation: String(policy.preemptiveRotation),
    refresh_interval_ms: String(policy.refreshIntervalMs), weekly_switch_threshold: String(policy.weeklyThreshold)
  })) updated = replaceTopLevel(updated, key, value);
  const edits = [];
  for (const name of names) {
    const p = path.join(config.root, 'profiles', name, 'config.toml');
    const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    let text = before;
    for (const [key, value] of Object.entries({
      fallback_threshold: policy.fallbackThreshold, weekly_threshold: policy.weeklyThreshold,
      check_scoped: policy.checkScoped, check_weekly: policy.checkWeekly, last_resort: name === policy.lastResort
    })) text = replaceTopLevel(text, key, String(value));
    edits.push({ p, before, text });
  }
  if (fs.readFileSync(file, 'utf8') !== original) throw new Error('Engine configuration changed during setup; retry after stopping the engine');
  for (const { p, before } of edits) {
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') !== before) throw new Error('Profile changed during configuration; retry after stopping the engine');
  }
  for (const { p, text } of edits) atomicWrite(p, text);
  atomicWrite(file, updated);
  return { registered: names, chain };
}
