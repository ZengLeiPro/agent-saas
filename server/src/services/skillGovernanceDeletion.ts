import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import { setUserSkillSelected } from '../routes/skillSelection.js';
import { personalSkillResourceId, tenantSkillResourceId } from './tenantSkillGovernanceUpload.js';

type DeletionGovernanceStore = Pick<PgSkillGovernanceStore, 'getResource'>
  & Partial<Pick<PgSkillGovernanceStore, 'retire'>>;

export async function archiveDeletedDirectory(targetDir: string): Promise<string> {
  const archiveDir = join(dirname(targetDir), '.deleted-skills');
  const archivedDir = join(archiveDir, `${basename(targetDir)}-${Date.now()}-${randomUUID()}`);
  await mkdir(archiveDir, { recursive: true });
  await rename(targetDir, archivedDir);
  return archivedDir;
}

async function restoreArchivedDirectory(archivedDir: string, targetDir: string): Promise<void> {
  if (!existsSync(targetDir) && existsSync(archivedDir)) await rename(archivedDir, targetDir);
}

export async function deleteTenantSkillWithGovernance(input: {
  skillDir: string;
  skillId: string;
  tenantId: string;
  actorUserId: string;
  skillConfigStore: SkillConfigStore;
  skillGovernanceStore?: DeletionGovernanceStore;
}): Promise<void> {
  let archivedDir: string | undefined;
  let configTouched = false;
  try {
    const resource = await input.skillGovernanceStore?.getResource(tenantSkillResourceId(input.tenantId, input.skillId));
    if (resource && (resource.tenantId !== input.tenantId || resource.scope !== 'tenant')) {
      throw new Error('Tenant Skill governance ownership mismatch');
    }
    archivedDir = await archiveDeletedDirectory(input.skillDir);
    await input.skillConfigStore.touchConfigVersion();
    configTouched = true;
    if (resource && resource.status !== 'retired') {
      if (!input.skillGovernanceStore?.retire) throw new Error('Skill governance retirement unavailable');
      await input.skillGovernanceStore.retire(input.tenantId, resource.skillId, resource.revision, input.actorUserId);
    }
  } catch (error) {
    if (archivedDir) await restoreArchivedDirectory(archivedDir, input.skillDir).catch(() => undefined);
    if (configTouched) await input.skillConfigStore.touchConfigVersion().catch(() => undefined);
    throw error;
  }
}

export async function deletePersonalSkillWithGovernance(input: {
  skillDir: string;
  skillId: string;
  tenantId: string;
  userId: string;
  username: string;
  skillConfigStore: SkillConfigStore;
  skillGovernanceStore?: DeletionGovernanceStore;
}): Promise<void> {
  let archivedDir: string | undefined;
  let selectionChanged = false;
  const wasSelected = input.skillConfigStore.getUserSelectedSkills(input.username).includes(input.skillId);
  try {
    const resource = await input.skillGovernanceStore?.getResource(personalSkillResourceId(input.userId, input.skillId));
    if (resource && (resource.tenantId !== input.tenantId
      || resource.scope !== 'personal'
      || resource.ownerUserId !== input.userId)) {
      throw new Error('Personal Skill governance ownership mismatch');
    }
    archivedDir = await archiveDeletedDirectory(input.skillDir);
    await setUserSkillSelected(input.skillConfigStore, input.username, input.skillId, false);
    selectionChanged = true;
    if (resource && resource.status !== 'retired') {
      if (!input.skillGovernanceStore?.retire) throw new Error('Skill governance retirement unavailable');
      await input.skillGovernanceStore.retire(input.tenantId, resource.skillId, resource.revision, input.userId);
    }
  } catch (error) {
    if (selectionChanged && wasSelected) {
      await setUserSkillSelected(input.skillConfigStore, input.username, input.skillId, true).catch(() => undefined);
    }
    if (archivedDir) await restoreArchivedDirectory(archivedDir, input.skillDir).catch(() => undefined);
    throw error;
  }
}
