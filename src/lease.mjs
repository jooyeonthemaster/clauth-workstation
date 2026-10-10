import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const LOCK_NAME = 'companion.lock';
const OWNER_NAME = 'owner.json';
const RECOVERY_NAME = 'recovery.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function leaseError(code, message) {
  return Object.assign(new Error(message), { code });
}

function locations(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required');
  const root = path.resolve(stateDir);
  const lock = path.join(root, LOCK_NAME);
  if (path.dirname(lock) !== root || path.basename(lock) !== LOCK_NAME) {
    throw new Error('Invalid supervisor lock path');
  }
  return { root, lock };
}

async function statDirectory(directory) {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw leaseError('SUPERVISOR_LOCK_UNSAFE', 'Supervisor lock is not a regular directory; refusing to modify it.');
    }
    return info;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readIdentity(directory, filename = OWNER_NAME) {
  await statDirectory(directory);
  const file = path.join(directory, filename);
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const owner = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!owner || typeof owner !== 'object' || owner.schema !== 1 || !UUID.test(owner.id) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return null;
    return owner;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function defaultCheckPid(pid) {
  try {
    process.kill(pid, 0); // Signal zero checks existence and never terminates.
    return 'alive';
  } catch (error) {
    return error.code === 'ESRCH' ? 'ESRCH' : error.code === 'EPERM' ? 'EPERM' : 'unknown';
  }
}

async function provenDead(checkPid, pid) {
  try { return await checkPid(pid) === 'ESRCH'; }
  catch (error) { return error.code === 'ESRCH'; }
}

async function writeIdentity(directory, filename, identity) {
  await fs.writeFile(path.join(directory, filename), `${JSON.stringify(identity)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
}

async function unlinkIdentity(directory, filename, expected) {
  if (!(await statDirectory(directory))) return false;
  const identity = await readIdentity(directory, filename);
  if (identity?.id !== expected.id || identity.pid !== expected.pid) return false;
  await fs.unlink(path.join(directory, filename));
  return true;
}

async function cleanupRetired(root, retired, owner, recovery) {
  // Only known files in our uniquely named retired directory are removed.
  // No recursive deletion and no operation on the replacement companion.lock.
  if (path.dirname(retired) !== root || !path.basename(retired).startsWith('.companion-retired-')) {
    throw new Error('Invalid retired supervisor lock path');
  }
  try {
    await unlinkIdentity(retired, OWNER_NAME, owner);
    await unlinkIdentity(retired, RECOVERY_NAME, recovery);
    await fs.rmdir(retired); // Unknown files are deliberately preserved.
  } catch { /* Failed cleanup leaves an inert retired directory for inspection. */ }
}

/**
 * Read-only maintenance check. This is not a transaction boundary: maintenance
 * that must exclude a concurrently starting supervisor must acquire a lease.
 * Even stale, incomplete or unrecognised leases are refused here.
 */
export async function assertNoSupervisor(stateDir) {
  const { lock } = locations(stateDir);
  try {
    await fs.lstat(lock);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw leaseError('SUPERVISOR_UNKNOWN', 'Supervisor lock state could not be read; maintenance refused.');
  }
  throw leaseError('SUPERVISOR_PRESENT', 'A supervisor lease exists. Stop the companion before offline maintenance.');
}

/**
 * One supervisor per stateDir, independent of its HTTP port. A dead PID is
 * recoverable only after an ESRCH result; EPERM and missing owner information
 * always fail closed. checkPid/now/pid are test seams and may be omitted.
 */
export async function acquireSupervisorLease(stateDir, {
  pid = process.pid, checkPid = defaultCheckPid, now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError('pid must be a positive integer');
  const { root, lock } = locations(stateDir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const owner = { schema: 1, pid, id: randomUUID(), createdAt: new Date(now()).toISOString() };

  async function initialize() {
    await fs.mkdir(lock, { mode: 0o700 });
    try {
      await writeIdentity(lock, OWNER_NAME, owner);
    } catch (error) {
      // rmdir removes only an empty directory; never remove an unknown owner.
      await fs.rmdir(lock).catch(() => {});
      throw error;
    }
  }

  try {
    await initialize();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await statDirectory(lock);
    if (!info) throw leaseError('SUPERVISOR_CHANGED', 'Supervisor lease changed while acquiring it; retry.');
    const prior = await readIdentity(lock);
    if (!prior) {
      throw leaseError('SUPERVISOR_OWNER_UNKNOWN', 'A supervisor is starting or its lease owner is unreadable; refusing takeover.');
    }
    if (!(await provenDead(checkPid, prior.pid))) {
      throw leaseError('SUPERVISOR_RUNNING', 'A supervisor already owns this state directory, or its process state cannot be safely verified.');
    }

    // This exclusive marker lives INSIDE the directory being recovered.
    // Competing recoverers either see it, or create their marker in a newly
    // replaced directory and then fail the UUID recheck below. This prevents a
    // stale observer from renaming a new owner's lease after another takeover.
    const recovery = { schema: 1, pid, id: randomUUID(), createdAt: new Date(now()).toISOString() };
    try {
      await writeIdentity(lock, RECOVERY_NAME, recovery);
    } catch {
      throw leaseError('SUPERVISOR_RECOVERY_BUSY', 'Supervisor recovery is already in progress or cannot be proven safe.');
    }
    let retired;
    try {
      const current = await readIdentity(lock);
      if (current?.id !== prior.id || current.pid !== prior.pid) {
        throw leaseError('SUPERVISOR_CHANGED', 'Supervisor ownership changed during recovery; refusing takeover.');
      }
      if (!(await provenDead(checkPid, current.pid))) {
        throw leaseError('SUPERVISOR_RUNNING', 'Supervisor process absence could not be confirmed; refusing takeover.');
      }
      retired = path.join(root, `.companion-retired-${randomUUID()}`);
      await fs.rename(lock, retired);
      try {
        await initialize();
      } catch (acquireError) {
        if (acquireError.code === 'EEXIST') {
          throw leaseError('SUPERVISOR_CHANGED', 'Another supervisor acquired the lease during recovery.');
        }
        throw acquireError;
      }
    } finally {
      if (retired) {
        await cleanupRetired(root, retired, prior, recovery);
      } else {
        await unlinkIdentity(lock, RECOVERY_NAME, recovery).catch(() => {});
      }
    }
  }

  let released = false;
  return {
    pid: owner.pid,
    id: owner.id,
    async release() {
      if (released) return false;
      if (!(await statDirectory(lock))) { released = true; return false; }
      const current = await readIdentity(lock);
      if (current?.id !== owner.id || current.pid !== owner.pid) {
        released = true;
        return false;
      }
      try {
        await fs.lstat(path.join(lock, RECOVERY_NAME));
        throw leaseError('SUPERVISOR_RECOVERY_BUSY', 'Lease recovery is in progress; release was deferred.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.unlink(path.join(lock, OWNER_NAME));
      try {
        await fs.rmdir(lock);
      } catch (error) {
        // Keep our identity when an unexpected file prevented release, so the
        // lease cannot become an ambiguous ownerless directory.
        await writeIdentity(lock, OWNER_NAME, owner).catch(() => {});
        throw error;
      }
      released = true;
      return true;
    },
  };
}
