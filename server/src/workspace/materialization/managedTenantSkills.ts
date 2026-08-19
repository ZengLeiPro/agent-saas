import { detectLegacyTenantSkillIds, type LegacyTenantSkillDetectionInput } from './legacyProvenance.js';
import { manifestTenantSkillIds, readSkillManifest } from './manifest.js';

export interface ManagedTenantSkillIdsInput extends LegacyTenantSkillDetectionInput {
  getCurrentTenantSkillIds?: () => Promise<ReadonlySet<string>>;
}

export async function resolveManagedTenantSkillIds(
  input: ManagedTenantSkillIdsInput,
): Promise<Set<string>> {
  const [currentTenantIds, manifest] = await Promise.all([
    input.getCurrentTenantSkillIds?.() ?? Promise.resolve(new Set<string>()),
    readSkillManifest(input.userCwd),
  ]);
  const legacyTenantIds = manifest
    ? new Set<string>()
    : await detectLegacyTenantSkillIds(input);
  return new Set([
    ...currentTenantIds,
    ...manifestTenantSkillIds(manifest),
    ...legacyTenantIds,
  ]);
}

export interface PersonalSkillProvenanceStore {
  getVersion(versionId: string): Promise<{ definition: Record<string, unknown> } | null>;
  listPersonalByOwner?: (
    tenantId: string,
    ownerUserId: string,
  ) => Promise<ReadonlyArray<{ currentVersionId?: string | null }>>;
}

export async function resolveUserPersonalSkillIds(
  user: { id: string; tenantId?: string },
  store?: PersonalSkillProvenanceStore,
): Promise<ReadonlySet<string> | undefined> {
  if (!store?.listPersonalByOwner || !user.tenantId) return undefined;
  const resources = await store.listPersonalByOwner(user.tenantId, user.id);
  const ids = new Set<string>();
  for (const resource of resources) {
    const version = resource.currentVersionId
      ? await store.getVersion(resource.currentVersionId)
      : undefined;
    const legacySkillId = version?.definition.legacySkillId;
    if (typeof legacySkillId === 'string' && legacySkillId) ids.add(legacySkillId);
  }
  return ids;
}
