import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

import { agentPath } from '../namespace.js';

export const SKILL_MATERIALIZATION_MANIFEST_VERSION = 1;

export interface MaterializedSkillEntry {
  digest: string;
  source: 'pool' | 'tenant';
}

export interface SkillMaterializationManifest {
  version: typeof SKILL_MATERIALIZATION_MANIFEST_VERSION;
  desiredHash: string;
  configVersion: number;
  /** 产出该副本的 release/source generation；旧 manifest 缺省。 */
  sourceRevision?: string;
  generatedAt: string;
  skills: Record<string, MaterializedSkillEntry>;
  scriptsDigest?: string;
}

export function skillManifestPath(userCwd: string): string {
  return agentPath(userCwd, 'skills-state.json');
}

export async function readSkillManifest(userCwd: string): Promise<SkillMaterializationManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(skillManifestPath(userCwd), 'utf-8')) as SkillMaterializationManifest;
    if (
      parsed.version !== SKILL_MATERIALIZATION_MANIFEST_VERSION
      || typeof parsed.desiredHash !== 'string'
      || !parsed.skills
      || typeof parsed.skills !== 'object'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(tempPath, content, 'utf-8');
  await rename(tempPath, path);
}

export async function writeSkillManifest(
  userCwd: string,
  manifest: SkillMaterializationManifest,
): Promise<void> {
  await writeAtomic(skillManifestPath(userCwd), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeAtomic(agentPath(userCwd, '.skills-version'), String(manifest.configVersion));
}
