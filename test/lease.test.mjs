import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { acquireSupervisorLease, assertNoSupervisor } from '../src/lease.mjs';

async function fixture(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clauth-lease-test-'));
  t.after(async () => {
    assert.equal(path.dirname(stateDir), os.tmpdir());
    assert.ok(path.basename(stateDir).startsWith('clauth-lease-test-'));
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  return { stateDir, lock: path.join(stateDir, 'companion.lock') };
}

async function seed(lock, pid = 101) {
  const owner = { schema: 1, pid, id: randomUUID(), createdAt: '2026-01-01T00:00:00Z' };
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
  return owner;
}

test('lease is exclusive per state directory and releases idempotently', async t => {
  const { stateDir } = await fixture(t);
  const first = await acquireSupervisorLease(stateDir, { pid: 201, checkPid: () => 'alive' });
  await assert.rejects(acquireSupervisorLease(stateDir, { pid: 202, checkPid: () => 'alive' }), { code: 'SUPERVISOR_RUNNING' });
  await assert.rejects(assertNoSupervisor(stateDir), { code: 'SUPERVISOR_PRESENT' });
  assert.equal(await first.release(), true);
  assert.equal(await first.release(), false);
  assert.equal(await assertNoSupervisor(stateDir), true);
});

test('EPERM and unknown process results never permit recovery', async t => {
  const { stateDir, lock } = await fixture(t);
  const owner = await seed(lock);
  for (const result of ['EPERM', 'unknown', false, undefined]) {
    await assert.rejects(acquireSupervisorLease(stateDir, { pid: 202, checkPid: () => result }), { code: 'SUPERVISOR_RUNNING' });
    assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).id, owner.id);
  }
});

test('only proven ESRCH allows stale recovery and retired directory cleanup', async t => {
  const { stateDir, lock } = await fixture(t);
  const old = await seed(lock);
  const lease = await acquireSupervisorLease(stateDir, { pid: 202, checkPid: oldPid => oldPid === old.pid ? 'ESRCH' : 'alive' });
  assert.notEqual(lease.id, old.id);
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).id, lease.id);
  assert.deepEqual(await fs.readdir(stateDir), ['companion.lock']);
  await lease.release();
});

test('thrown ESRCH is accepted but other probe errors fail closed', async t => {
  const { stateDir, lock } = await fixture(t);
  await seed(lock);
  await assert.rejects(acquireSupervisorLease(stateDir, { pid: 202, checkPid: () => { throw new Error('probe unavailable'); } }), { code: 'SUPERVISOR_RUNNING' });
  const lease = await acquireSupervisorLease(stateDir, { pid: 202, checkPid: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
  await lease.release();
});

test('missing and malformed owners are refused even when old', async t => {
  const { stateDir, lock } = await fixture(t);
  await fs.mkdir(lock);
  let calls = 0;
  const options = { pid: 202, checkPid: () => { calls++; return 'ESRCH'; } };
  await assert.rejects(acquireSupervisorLease(stateDir, options), { code: 'SUPERVISOR_OWNER_UNKNOWN' });
  await fs.writeFile(path.join(lock, 'owner.json'), '{broken');
  await assert.rejects(acquireSupervisorLease(stateDir, options), { code: 'SUPERVISOR_OWNER_UNKNOWN' });
  await fs.writeFile(path.join(lock, 'owner.json'), 'null');
  await assert.rejects(acquireSupervisorLease(stateDir, options), { code: 'SUPERVISOR_OWNER_UNKNOWN' });
  assert.equal(calls, 0);
});

test('assertNoSupervisor is read only and refuses stale leases', async t => {
  const { stateDir, lock } = await fixture(t);
  const old = await seed(lock);
  await assert.rejects(assertNoSupervisor(stateDir), { code: 'SUPERVISOR_PRESENT' });
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).id, old.id);
});

test('concurrent stale recoverers never delete the winner', async t => {
  const { stateDir, lock } = await fixture(t);
  const old = await seed(lock);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
    acquireSupervisorLease(stateDir, { pid: 300 + i, checkPid: pid => pid === old.pid ? 'ESRCH' : 'alive' })));
  const winners = results.filter(result => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  const lease = winners[0].value;
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).id, lease.id);
  await lease.release();
});

test('concurrent fresh acquisitions produce one winner', async t => {
  const { stateDir, lock } = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
    acquireSupervisorLease(stateDir, { pid: 500 + i, checkPid: () => 'alive' })));
  const winners = results.filter(result => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).id, winners[0].value.id);
  await winners[0].value.release();
});

test('release cannot delete a replacement owner with another UUID', async t => {
  const { stateDir, lock } = await fixture(t);
  const first = await acquireSupervisorLease(stateDir, { pid: 701, checkPid: () => 'alive' });
  const second = await acquireSupervisorLease(stateDir, { pid: 702, checkPid: pid => pid === 701 ? 'ESRCH' : 'alive' });
  assert.equal(await first.release(), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).id, second.id);
  await second.release();
});

test('unexpected files prevent recursive deletion during release', async t => {
  const { stateDir, lock } = await fixture(t);
  const lease = await acquireSupervisorLease(stateDir, { pid: 801, checkPid: () => 'alive' });
  await fs.writeFile(path.join(lock, 'keep.txt'), 'do not remove');
  await assert.rejects(lease.release());
  assert.equal(await fs.readFile(path.join(lock, 'keep.txt'), 'utf8'), 'do not remove');
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).id, lease.id);
  await fs.unlink(path.join(lock, 'keep.txt'));
  await lease.release();
});

test('interrupted recovery marker fails closed and preserves both identities', async t => {
  const { stateDir, lock } = await fixture(t);
  const old = await seed(lock);
  await fs.writeFile(path.join(lock, 'recovery.json'), JSON.stringify({ schema: 1, pid: 999, id: randomUUID() }));
  await assert.rejects(acquireSupervisorLease(stateDir, { pid: 802, checkPid: () => 'ESRCH' }), { code: 'SUPERVISOR_RECOVERY_BUSY' });
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).id, old.id);
});

test('regular file at lock path is never deleted or treated as a lock directory', async t => {
  const { stateDir, lock } = await fixture(t);
  await fs.writeFile(lock, 'preserve');
  await assert.rejects(acquireSupervisorLease(stateDir, { pid: 803, checkPid: () => 'ESRCH' }), { code: 'SUPERVISOR_LOCK_UNSAFE' });
  assert.equal(await fs.readFile(lock, 'utf8'), 'preserve');
});
