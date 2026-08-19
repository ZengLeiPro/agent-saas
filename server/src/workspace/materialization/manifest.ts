import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

import { agentPath } from '../namespace.js';

export const SKILL_MATERIALIZATION_MANIFEST_VERSION = 1;

export interface MaterializedSkillEntry {
  digest: string;
  source: 'pool' | 'tenant';
  /** 组织来源租户；旧 manifest 缺省时仍按 source=tenant 视为受管副本。 */
  tenantId?: string;
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

function parseSkillManifest(content: string): SkillMaterializationManifest | null {
  try {
    const parsed = JSON.parse(content) as SkillMaterializationManifest;
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

export async function readSkillManifest(userCwd: string): Promise<SkillMaterializationManifest | null> {
  try {
    return parseSkillManifest(await readFile(skillManifestPath(userCwd), 'utf-8'));
  } catch {
    return null;
  }
}

export function manifestTenantSkillIds(manifest: SkillMaterializationManifest | null): Set<string> {
  return new Set(
    Object.entries(manifest?.skills ?? {})
      .filter(([, entry]) => entry?.source === 'tenant')
      .map(([id]) => id),
  );
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
