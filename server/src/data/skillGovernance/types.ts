export const MATERIALIZED_CONTENT_DIGEST_ALGORITHM = 'materialized-v2';
export type GovernedSkillScope = 'platform' | 'tenant' | 'personal';
export type GovernedSkillStatus = 'draft' | 'published' | 'retired';
export type SkillCandidateStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'published';

export interface GovernedSkillResource {
  skillId: string;
  tenantId: string;
  scope: GovernedSkillScope;
  ownerUserId?: string;
  status: GovernedSkillStatus;
  currentVersionId?: string;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface GovernedSkillVersion {
  versionId: string;
  skillId: string;
  versionNumber: number;
  definition: Record<string, unknown>;
  digest: string;
  sourceCandidateId?: string;
  publishedAt: string;
  publishedBy: string;
}

/** 旧版治理摘要与当前物化摘要的兼容视图。 */
export interface SkillHistoricalProvenance {
  /** 按当前物化副本规则计算的摘要。 */
  digests: readonly string[];
  /** 旧版上传算法（包含未物化目录）留下的摘要，仅作一次性归属迁移凭据。 */
  legacyDigests: readonly string[];
}

export interface SkillCandidate {
  candidateId: string;
  tenantId: string;
  ownerUserId: string;
  targetSkillId: string;
  definition: Record<string, unknown>;
  digest: string;
  status: SkillCandidateStatus;
  revision: number;
  submittedAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewReason?: string;
  publishedVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export type SkillGovernanceInvariantCode =
  | 'SKILL_RESOURCE_INVALID'
  | 'SKILL_RESOURCE_NOT_FOUND'
  | 'SKILL_RESOURCE_TENANT_MISMATCH'
  | 'SKILL_RESOURCE_VERSION_CONFLICT'
  | 'SKILL_RESOURCE_RETIRED'
  | 'SKILL_PERSONAL_OWNER_REQUIRED'
  | 'SKILL_DEFINITION_SENSITIVE'
  | 'SKILL_CANDIDATE_NOT_FOUND'
  | 'SKILL_CANDIDATE_VERSION_CONFLICT'
  | 'SKILL_CANDIDATE_INVALID_TRANSITION'
  | 'SKILL_CANDIDATE_OWNER_MISMATCH'
  | 'SKILL_CANDIDATE_DIGEST_MISMATCH';

export class SkillGovernanceInvariantError extends Error {
  constructor(readonly code: SkillGovernanceInvariantCode) {
    super(code);
    this.name = 'SkillGovernanceInvariantError';
  }
}
