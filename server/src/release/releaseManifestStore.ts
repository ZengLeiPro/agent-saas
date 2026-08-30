import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  canonicalJson,
  releaseManifestSchema,
  type ReleaseManifest,
  type ReleaseManifestContent,
} from '@agent/shared';

export interface StoredReleaseManifest {
  manifest: ReleaseManifest;
  manifestDigest: string;
}

export function calculateManifestDigest(manifest: ReleaseManifestContent): string {
  return `sha256:${createHash('sha256')
    .update(`agent-saas-release-manifest-v${manifest.schemaVersion}\0`)
    .update(canonicalJson(manifest))
    .digest('hex')}`;
}

export function validateManifest(manifest: unknown): ReleaseManifest {
  const parsed = releaseManifestSchema.parse(manifest);
  const { digest, ...unsignedManifest } = parsed;
  const calculated = calculateManifestDigest(unsignedManifest);
  if (digest !== calculated) {
    throw new Error('Release Manifest digest does not match its versioned canonical content');
  }
  return parsed;
}

export class ReleaseManifestStore {
  constructor(private readonly rootDir: string) {}

  private pathFor(releaseId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)) {
      throw new Error('Release ID cannot be used as a manifest filename');
    }
    return join(this.rootDir, `${releaseId}.json`);
  }

  async create(manifest: unknown): Promise<StoredReleaseManifest> {
    const validated = validateManifest(manifest);
    const destination = this.pathFor(validated.releaseId);
    await mkdir(dirname(destination), { recursive: true });
    const content = `${canonicalJson(validated)}\n`;

    try {
      await writeFile(destination, content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Release Manifest ${validated.releaseId} already exists and is immutable`);
      }
      throw error;
    }

    return { manifest: validated, manifestDigest: validated.digest };
  }

  async read(releaseId: string): Promise<StoredReleaseManifest> {
    const content = await readFile(this.pathFor(releaseId), 'utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new Error(`Stored Release Manifest ${releaseId} is not valid JSON`);
    }
    const manifest = validateManifest(raw);
    if (manifest.releaseId !== releaseId)
      throw new Error(`Stored Release Manifest ${releaseId} has a mismatched releaseId`);
    return { manifest, manifestDigest: manifest.digest };
  }
}
