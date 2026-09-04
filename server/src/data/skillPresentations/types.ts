export type SkillPresentationResourceScope = 'platform' | 'tenant';
export type SkillPresentationSource =
  'platform_default' | 'organization_override' | 'organization_default';

export interface SkillPresentationKey {
  resourceScope: SkillPresentationResourceScope;
  resourceTenantId: string;
  skillId: string;
  audienceTenantId: string;
  locale: string;
}

export interface SkillPresentationRecord extends SkillPresentationKey {
  displayName: string;
  summary: string;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface SkillPresentationView {
  displayName: string;
  summary: string;
  locale: string;
  source: SkillPresentationSource | 'fallback';
  revision?: number;
}

export interface UpsertSkillPresentationInput extends SkillPresentationKey {
  displayName: string;
  summary: string;
  expectedRevision: number;
  updatedBy: string;
}

export class SkillPresentationConflictError extends Error {
  readonly code = 'SKILL_PRESENTATION_VERSION_CONFLICT';

  constructor() {
    super('技能展示信息已被其他管理员修改，请刷新后重试');
    this.name = 'SkillPresentationConflictError';
  }
}

export interface SkillPresentationStore {
  getExact(key: SkillPresentationKey): Promise<SkillPresentationRecord | null>;
  listEffectivePlatform(
    skillIds: readonly string[],
    tenantId?: string,
  ): Promise<Map<string, SkillPresentationRecord>>;
  listTenantOwned(
    skillIds: readonly string[],
    tenantId: string,
  ): Promise<Map<string, SkillPresentationRecord>>;
  upsert(input: UpsertSkillPresentationInput): Promise<SkillPresentationRecord>;
  delete(key: SkillPresentationKey, expectedRevision: number): Promise<void>;
}
