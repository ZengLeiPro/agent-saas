import type {
  SkillPresentationRecord,
  SkillPresentationStore,
  SkillPresentationView,
} from '../data/skillPresentations/index.js';

interface SkillMeta {
  id: string;
  name: string;
  description: string;
}

function fallback(skill: SkillMeta): SkillPresentationView {
  return {
    displayName: skill.name,
    summary: skill.description,
    locale: 'zh-CN',
    source: 'fallback',
  };
}

function fromRecord(
  record: SkillPresentationRecord,
  source: Exclude<SkillPresentationView['source'], 'fallback'>,
  includeRevision = true,
): SkillPresentationView {
  return {
    displayName: record.displayName,
    summary: record.summary,
    locale: 'zh-CN',
    source,
    ...(includeRevision ? { revision: record.revision } : {}),
  };
}

export async function withPlatformPresentations<T extends SkillMeta>(
  store: SkillPresentationStore | undefined,
  skills: readonly T[],
  tenantId?: string,
): Promise<Array<T & { presentation: SkillPresentationView }>> {
  const records = store
    ? await store.listEffectivePlatform(
        skills.map((skill) => skill.id),
        tenantId,
      )
    : new Map<string, SkillPresentationRecord>();
  return skills.map((skill) => {
    const record = records.get(skill.id);
    if (!record) return { ...skill, presentation: fallback(skill) };
    const overridden = Boolean(tenantId && record.audienceTenantId === tenantId);
    return {
      ...skill,
      presentation: fromRecord(
        record,
        overridden ? 'organization_override' : 'platform_default',
        !tenantId || overridden,
      ),
    };
  });
}

export async function withTenantPresentations<T extends SkillMeta>(
  store: SkillPresentationStore | undefined,
  skills: readonly T[],
  tenantId: string,
): Promise<Array<T & { presentation: SkillPresentationView }>> {
  const records = store
    ? await store.listTenantOwned(
        skills.map((skill) => skill.id),
        tenantId,
      )
    : new Map<string, SkillPresentationRecord>();
  return skills.map((skill) => {
    const record = records.get(skill.id);
    return {
      ...skill,
      presentation: record ? fromRecord(record, 'organization_default') : fallback(skill),
    };
  });
}

export function fallbackPresentation(skill: SkillMeta): SkillPresentationView {
  return fallback(skill);
}
