import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, POLICY, replaceTopLevel } from '../src/config.mjs';
import { initialize, isManaged, configure } from '../src/setup.mjs';

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const home = fs.mkdtempSync(path.join(base, 'clauth-workstation-setup-test-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(home)), base);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return paths({ home });
}

function profile(config, name, { credentials = true, text = '' } = {}) {
  const dir = path.join(config.root, 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  if (credentials) fs.writeFileSync(path.join(dir, 'credentials.json'), '{"fixture":"DO_NOT_COPY_CREDENTIALS"}');
  fs.writeFileSync(path.join(dir, 'config.toml'), text);
  return dir;
}

function roster(config, names, extra = '') {
  fs.writeFileSync(path.join(config.root, 'profiles.toml'), `profiles = ${JSON.stringify(names)}\nfallback_chain = ${JSON.stringify(names)}\n${extra}`);
}

test('fresh initialization creates policy metadata without copying the existing Claude login', t => {
  const config = fixture(t);
  fs.mkdirSync(path.dirname(config.livePath), { recursive: true });
  const login = '{"private_fixture":"NEVER_PUBLISH_THIS_LOGIN"}';
  fs.writeFileSync(config.livePath, login);
  assert.equal(initialize(config), true);
  assert.equal(isManaged(config), true);
  assert.equal(initialize(config), false);
  assert.equal(fs.readFileSync(config.livePath, 'utf8'), login);
  const state = fs.readFileSync(path.join(config.root, 'profiles.toml'), 'utf8');
  assert.match(state, /^profiles = \[\]$/m);
  assert.match(state, /^weekly_switch_threshold = 98$/m);
  assert.doesNotMatch(state, /^weekly_threshold\s*=/m);
  assert.doesNotMatch(state, /NEVER_PUBLISH_THIS_LOGIN|accessToken|refreshToken|api_key/);
  const marker = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'managed-root.json'), 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['createdAt', 'root']);
});

test('initialization refuses preexisting profile configuration and leaves it byte-identical', t => {
  const config = fixture(t);
  fs.mkdirSync(config.root, { recursive: true });
  const target = path.join(config.root, 'profiles.toml');
  const original = 'profiles = ["existing"]\n# preserve me\n';
  fs.writeFileSync(target, original);
  assert.throws(() => initialize(config), /Existing clauth/);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(config.stateDir, 'managed-root.json')), false);
});

test('initialization refuses an existing profiles directory even when state file is missing', t => {
  const config = fixture(t);
  profile(config, 'existing');
  assert.throws(() => initialize(config), /Existing clauth/);
  assert.equal(fs.existsSync(path.join(config.root, 'profiles.toml')), false);
});

test('configure applies fallback policy while preserving login bytes and unrelated TOML tables', t => {
  const config = fixture(t);
  initialize(config);
  const dir = profile(config, 'main', { text: 'disabled = true\ncustom_scalar = "keep"\n\n[env]\nPRIVATE_FIXTURE = "LOCAL_ONLY"\n\n[models]\ndefault = "sonnet"\n' });
  profile(config, 'acc3');
  roster(config, ['main', 'acc3'], 'active_profile = "main"\n\n[update]\nauto_update = false\ncustom_future = "preserve"\n');
  const credentials = fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8');
  const result = configure(config);
  assert.deepEqual(result.chain, ['main', 'acc3']);
  assert.equal(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'), credentials);
  const state = fs.readFileSync(path.join(config.root, 'profiles.toml'), 'utf8');
  assert.match(state, /^active_profile = "main"$/m);
  assert.match(state, /^weekly_switch_threshold = 98$/m);
  assert.match(state, /\[update\]\nauto_update = false\ncustom_future = "preserve"/);
  assert.doesNotMatch(state, /DO_NOT_COPY_CREDENTIALS|LOCAL_ONLY/);
  const configured = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
  assert.match(configured, /^disabled = true$/m);
  assert.match(configured, /^fallback_threshold = 85$/m);
  assert.match(configured, /^weekly_threshold = 98$/m);
  assert.match(configured, /\[env\]\nPRIVATE_FIXTURE = "LOCAL_ONLY"\n\n\[models\]\ndefault = "sonnet"/);
});

test('configure cannot resurrect unregistered credential directories or erase an API profile', t => {
  const config = fixture(t);
  initialize(config);
  profile(config, 'main');
  profile(config, 'orphan');
  const api = profile(config, 'api', { credentials: false, text: 'base_url = "https://example.invalid"\napi_key = "FIXTURE_LOCAL_KEY"\n' });
  roster(config, ['main', 'api'], 'active_profile = "main"\n');
  const apiBefore = fs.readFileSync(path.join(api, 'config.toml'), 'utf8');
  const result = configure(config, { ...POLICY, fallbackOrder: ['main'] });
  const state = fs.readFileSync(path.join(config.root, 'profiles.toml'), 'utf8');
  assert.match(state, /^profiles\s*=\s*\["main",\s*"api"\]$/m);
  assert.doesNotMatch(state, /orphan/);
  assert.deepEqual(result.chain, ['main']);
  assert.equal(fs.readFileSync(path.join(api, 'config.toml'), 'utf8'), apiBefore);
});

test('roster comments cannot register accounts and TOML literal profile names stay registered', t => {
  const config = fixture(t);
  initialize(config);
  profile(config, 'main');
  profile(config, 'orphan');
  fs.writeFileSync(path.join(config.root, 'profiles.toml'), "profiles = [\n  'main', # 'orphan'\n]\nfallback_chain = []\n");
  const result = configure(config);
  assert.deepEqual(result.registered, ['main']);
  assert.deepEqual(result.chain, ['main']);
});

test('a malformed later profile causes no policy writes to earlier profiles', t => {
  const config = fixture(t);
  initialize(config);
  const dir = profile(config, 'main', { text: 'fallback_threshold = 91\n' });
  profile(config, 'acc3', { text: 'fallback_threshold = 92\nfallback_threshold = 93\n' });
  roster(config, ['main', 'acc3']);
  const state = fs.readFileSync(path.join(config.root, 'profiles.toml'), 'utf8');
  assert.throws(() => configure(config), /Duplicate/);
  assert.equal(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'), 'fallback_threshold = 91\n');
  assert.equal(fs.readFileSync(path.join(config.root, 'profiles.toml'), 'utf8'), state);
});

test('TOML edits support multiline arrays and preserve scoped keys with the same name', () => {
  const input = 'profiles = [\n  "main",\n  "acc3",\n]\n\n[env]\nprofiles = "scoped value"\n';
  const output = replaceTopLevel(input, 'profiles', '["main"]');
  assert.equal(output, 'profiles = ["main"]\n\n[env]\nprofiles = "scoped value"\n');
  assert.throws(() => replaceTopLevel('profiles = []\nprofiles = []\n', 'profiles', '[]'), /Duplicate/);
});

test('TOML policy edits do not rewrite keys in array-of-table or numeric-named sections', () => {
  for (const header of ['[[future]]', '[123]']) {
    const input = `profiles = []\n${header}\nweekly_switch_threshold = 70\n`;
    const output = replaceTopLevel(input, 'weekly_switch_threshold', '98');
    assert.equal(output, `weekly_switch_threshold = 98\n${input}`);
  }
});

test('configure refuses an unmanaged root without creating files', t => {
  const config = fixture(t);
  assert.throws(() => configure(config), /not managed/);
  assert.equal(fs.existsSync(config.root), false);
});
