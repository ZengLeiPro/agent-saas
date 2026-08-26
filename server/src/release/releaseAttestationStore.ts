import { appendFile, mkdir, readFile } from 'node:fs/promises';
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
    const log = await this.read(releaseId, manifestDigest);
    const before = log.list().length;
    const entry = log.append(input);
    if (log.list().length === before) return entry;

    const path = this.pathFor(releaseId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
    return entry;
  }
}
