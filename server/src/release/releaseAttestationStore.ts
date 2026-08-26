import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { hostname as systemHostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ReleaseAttestationLog,
  type ReleaseAttestation,
  type ReleaseAttestationTiming,
} from './releaseAttestation.js';

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 10;

interface AttestationLockOwner {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

interface HeldAttestationLock {
  handle: Awaited<ReturnType<typeof open>>;
  lockPath: string;
  token: string;
}

export interface ReleaseAttestationStoreOptions extends ReleaseAttestationTiming {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  lockHostname?: string;
  lockProcessExists?: (pid: number) => boolean;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function assertReleaseId(releaseId: string): void {
  if (!/^rc-\d{8}-\d{2,}$/.test(releaseId)) {
    throw new Error('Attestation releaseId cannot be used as a log filename');
  }
}

export class ReleaseAttestationStore {
  constructor(
    private readonly rootDir: string,
    private readonly timing: ReleaseAttestationStoreOptions = {},
  ) {}

  private pathFor(releaseId: string): string {
    assertReleaseId(releaseId);
    return join(this.rootDir, `${releaseId}.jsonl`);
  }

  private async tryRecoverAbandonedLock(lockPath: string): Promise<boolean> {
    let owner: AttestationLockOwner;
    try {
      owner = JSON.parse(await readFile(lockPath, 'utf8')) as AttestationLockOwner;
    } catch {
      return false;
    }
    if (
      !owner.token ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      owner.hostname !== (this.timing.lockHostname ?? systemHostname())
    ) {
      return false;
    }
    const ownerAlive = (this.timing.lockProcessExists ?? processExists)(owner.pid);
    if (ownerAlive) return false;

    const recoveryPath = `${lockPath}.recovery`;
    try {
      await link(lockPath, recoveryPath);
    } catch (error) {
      if (errorCode(error) === 'EEXIST' || errorCode(error) === 'ENOENT') return false;
      throw error;
    }
    try {
      const [current, recovery] = await Promise.all([stat(lockPath), stat(recoveryPath)]);
      const recoveryOwner = JSON.parse(
        await readFile(recoveryPath, 'utf8'),
      ) as AttestationLockOwner;
      if (
        current.dev !== recovery.dev ||
        current.ino !== recovery.ino ||
        recoveryOwner.token !== owner.token
      ) {
        return false;
      }
      await unlink(lockPath);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    } finally {
      await unlink(recoveryPath).catch(() => undefined);
    }
  }

  private async acquireReleaseLock(releaseId: string): Promise<HeldAttestationLock> {
    const path = this.pathFor(releaseId);
    const lockPath = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true });
    const timeoutMs = Math.max(0, this.timing.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    const retryMs = Math.max(1, this.timing.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const token = randomUUID();
      const candidatePath = `${lockPath}.candidate-${token}`;
      const handle = await open(candidatePath, 'wx', 0o600);
      let published = false;
      try {
        const owner: AttestationLockOwner = {
          token,
          pid: process.pid,
          hostname: this.timing.lockHostname ?? systemHostname(),
          acquiredAt: new Date().toISOString(),
        };
        await handle.writeFile(JSON.stringify(owner), 'utf8');
        await handle.sync();
        await link(candidatePath, lockPath);
        published = true;
        await unlink(candidatePath);
        return { handle, lockPath, token };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(candidatePath).catch(() => undefined);
        if (published) {
          try {
            const current = JSON.parse(await readFile(lockPath, 'utf8')) as AttestationLockOwner;
            if (current.token === token) await unlink(lockPath).catch(() => undefined);
          } catch {
            // Never remove a lock whose ownership can no longer be proven.
          }
        }
        if (errorCode(error) !== 'EEXIST') throw error;
        if (await this.tryRecoverAbandonedLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring attestation lock for ${releaseId}`);
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }
  }

  private async releaseLock(lock: HeldAttestationLock): Promise<void> {
    await lock.handle.close().catch(() => undefined);
    try {
      const owner = JSON.parse(await readFile(lock.lockPath, 'utf8')) as AttestationLockOwner;
      if (owner.token === lock.token) await unlink(lock.lockPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  private async withReleaseLock<T>(releaseId: string, operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquireReleaseLock(releaseId);
    try {
      return await operation();
    } finally {
      await this.releaseLock(lock);
    }
  }

  async read(releaseId: string, manifestDigest: string): Promise<ReleaseAttestationLog> {
    const path = this.pathFor(releaseId);
    let content = '';
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const entries = content
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line, index): ReleaseAttestation => {
        try {
          return JSON.parse(line) as ReleaseAttestation;
        } catch {
          throw new Error(`Stored attestation line ${index + 1} is not valid JSON`);
        }
      });
    return ReleaseAttestationLog.hydrate(releaseId, manifestDigest, entries, this.timing);
  }

  async append(
    releaseId: string,
    manifestDigest: string,
    input: Parameters<ReleaseAttestationLog['append']>[0],
  ): Promise<ReleaseAttestation> {
    return this.withReleaseLock(releaseId, async () => {
      const log = await this.read(releaseId, manifestDigest);
      const before = log.list().length;
      const entry = log.append(input);
      if (log.list().length === before) return entry;

      const handle = await open(this.pathFor(releaseId), 'a', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return entry;
    });
  }
}
