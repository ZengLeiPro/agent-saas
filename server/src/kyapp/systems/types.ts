/**
 * WP2a 系统目录三表的领域类型（规范 §8.1、§8.3）。
 *
 * 状态机照 connectorCatalog：`draft → published → disabled → retired`，`retired` 为终态。
 * 版本以 manifest 的 JCS digest 标识，不可变；同 digest 重复登记即幂等。
 */

/** 系统定义与系统版本共用的状态机取值。 */
export const KY_APP_SYSTEM_STATUSES = ['draft', 'published', 'disabled', 'retired'] as const;
export type KyAppSystemStatus = (typeof KY_APP_SYSTEM_STATUSES)[number];

/** 安装实例状态（规范 §3.7 行为矩阵，`deleted` 为吸收终态）。 */
export const KY_APP_INSTALLATION_STATUSES = ['pending', 'enabled', 'disabled', 'deleted'] as const;
export type KyAppInstallationStatus = (typeof KY_APP_INSTALLATION_STATUSES)[number];

/** 发布门禁的复核状态（规范 §8.1：语义 diff 命中即需非发布者复核）。 */
export const KY_APP_REVIEW_STATUSES = ['not_required', 'pending', 'approved'] as const;
export type KyAppReviewStatus = (typeof KY_APP_REVIEW_STATUSES)[number];

export interface KyAppSystemDefinition {
  systemId: string;
  name: string;
  status: KyAppSystemStatus;
  /** 当前已发布版本的 digest；未发布为 null。 */
  publishedDigest: string | null;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface KyAppSystemVersion {
  systemId: string;
  digest: string;
  contractVersion: number;
  manifest: Record<string, unknown>;
  status: KyAppSystemStatus;
  reviewStatus: KyAppReviewStatus;
  /** 语义 diff 命中的原因列表，供人工复核界面展示。 */
  reviewReasons: string[];
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  createdBy: string;
  publishedAt: string | null;
  publishedBy: string | null;
}

export interface KyAppInstallation {
  installationId: string;
  tenantId: string;
  systemId: string;
  baseUrl: string;
  origin: string;
  techContactUserId: string;
  status: KyAppInstallationStatus;
  domainVerificationToken: string | null;
  domainVerifiedAt: string | null;
  /** CAS 切换后的登记 digest；能力调用以它比对 SAT `dig`（规范 §8.1 发布顺序）。 */
  registeredDigest: string | null;
  stateVersion: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface RegisterKyAppVersionInput {
  systemId: string;
  name: string;
  manifest: Record<string, unknown>;
  reviewStatus?: KyAppReviewStatus;
  reviewReasons?: readonly string[];
  actor: string;
}

export interface PublishKyAppVersionInput {
  systemId: string;
  digest: string;
  /** 乐观锁：必须等于系统定义当前 `version`。 */
  expectedVersion: number;
  actor: string;
}

export interface CreateKyAppInstallationInput {
  installationId: string;
  tenantId: string;
  systemId: string;
  baseUrl: string;
  origin: string;
  techContactUserId: string;
  domainVerificationToken?: string;
  actor: string;
}

/** 冲突（乐观锁失配、状态机非法跃迁、CAS 前置条件不成立）统一用这个错误。 */
export class KyAppSystemConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KyAppSystemConflictError';
  }
}

export class KyAppSystemNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KyAppSystemNotFoundError';
  }
}

/**
 * 三表读写的最小接口。`runtimeAssignmentResourceResolver` 等消费方只依赖它，
 * 避免把 PG 实现类型泄漏到运行时装配之外。
 */
export interface KyAppSystemStore {
  listDefinitions?(): Promise<KyAppSystemDefinition[]>;
  getDefinition(systemId: string): Promise<KyAppSystemDefinition | null>;
  getVersion(systemId: string, digest: string): Promise<KyAppSystemVersion | null>;
  getInstallation(installationId: string): Promise<KyAppInstallation | null>;
}

/** 状态机：允许的迁移边（规范 §8.1，`retired` 终态）。 */
export const KY_APP_SYSTEM_TRANSITIONS: Readonly<
  Record<KyAppSystemStatus, readonly KyAppSystemStatus[]>
> = {
  draft: ['published'],
  published: ['disabled', 'retired'],
  disabled: ['published', 'retired'],
  retired: [],
};

/** 安装实例状态机：`deleted` 为吸收终态。 */
export const KY_APP_INSTALLATION_TRANSITIONS: Readonly<
  Record<KyAppInstallationStatus, readonly KyAppInstallationStatus[]>
> = {
  pending: ['enabled', 'disabled', 'deleted'],
  enabled: ['disabled', 'deleted'],
  disabled: ['enabled', 'deleted'],
  deleted: [],
};

export function canTransitionSystemStatus(from: KyAppSystemStatus, to: KyAppSystemStatus): boolean {
  return KY_APP_SYSTEM_TRANSITIONS[from].includes(to);
}

export function canTransitionInstallationStatus(
  from: KyAppInstallationStatus,
  to: KyAppInstallationStatus,
): boolean {
  return KY_APP_INSTALLATION_TRANSITIONS[from].includes(to);
}
