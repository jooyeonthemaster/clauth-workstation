import test from 'node:test';
import assert from 'node:assert/strict';
import { engineEnvironment } from '../src/engine.mjs';

test('engine child environment preserves parent and removes profile redirection', () => {
  const before = { CLAUDE_CONFIG_DIR: '/session', CODEX_HOME: '/other', PATH: '/test' };
  const after = engineEnvironment('start', before);
  assert.equal(after.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(after.CODEX_HOME, undefined);
  assert.equal(after.CLAUTH_NO_UPDATE, '1');
  assert.equal(after.CLAUTH_NO_COMPLETIONS, '1');
  assert.equal(after.PATH, '/test');
  assert.equal(before.CLAUDE_CONFIG_DIR, '/session');
});

test('session launcher refuses authentication overrides without echoing their values', () => {
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    assert.throws(() => engineEnvironment('start', { [name]: 'fixture-secret-value' }), error => {
      assert.ok(error.message.includes(name));
      assert.ok(!error.message.includes('fixture-secret-value'));
      return true;
    });
  }
});
