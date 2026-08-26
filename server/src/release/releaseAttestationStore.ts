import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ReleaseAttestationLog,
  type ReleaseAttestation,
  type ReleaseAttestationTiming,
} from './releaseAttestation.js';

function assertReleaseId(releaseId: string): void {
  if (!/^rc-\d{8}-\d{2,}$/.test(releaseId)) {
    throw new Error('Attestation releaseId cannot be used as a log filename');
  }
}

export class ReleaseAttestationStore {
  constructor(
    private readonly rootDir: string,
    private readonly timing: ReleaseAttestationTiming = {},
  ) {}

  private pathFor(releaseId: string): string {
    assertReleaseId(releaseId);
    return join(this.rootDir, `${releaseId}.jsonl`);
  }

  private async withReleaseLock<T>(releaseId: string, operation: () => Promise<T>): Promise<T> {
    const path = this.pathFor(releaseId);
    const lockPath = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring attestation lock for ${releaseId}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
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

      await appendFile(this.pathFor(releaseId), `${JSON.stringify(entry)}\n`, {
        encoding: 'utf8',
        flag: 'a',
      });
      return entry;
    });
  }
}
