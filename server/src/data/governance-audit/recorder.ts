import { createHash, randomUUID } from 'node:crypto';

import type { GovernanceAuditEvent, GovernanceAuditMetadata, GovernanceAuditStore } from './types.js';
import { governancePersonaForUser } from '../../governance/subject/platformIdentity.js';

export interface GovernanceActor {
  sub: string;
  role: string;
  tenantId?: string;
}

export interface GovernanceChangeInput {
  action: string;
  targetType: string;
  targetId: string;
  targetTenantId?: string;
  purpose: string;
  reason?: string;
  beforeDigest?: string;
  metadata?: GovernanceAuditMetadata;
}

export class GovernanceAuditUnavailableError extends Error {
  readonly code = 'GOVERNANCE_AUDIT_UNAVAILABLE';

  constructor(message = '治理审计暂不可用，高风险操作已阻止') {
    super(message);
    this.name = 'GovernanceAuditUnavailableError';
  }
}

export function governanceDigest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export async function recordGovernanceIntent(
  store: GovernanceAuditStore | undefined,
  actor: GovernanceActor,
  input: GovernanceChangeInput,
): Promise<GovernanceAuditEvent> {
  if (!store) throw new GovernanceAuditUnavailableError();
  try {
    return await store.append({
      correlationId: randomUUID(),
      actorType: 'user',
      actorUserId: actor.sub,
      actorPersona: governancePersonaForUser(actor),
      ...(actor.tenantId ? { actorTenantId: actor.tenantId } : {}),
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      ...(input.targetTenantId ? { targetTenantId: input.targetTenantId } : {}),
      purpose: input.purpose,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.beforeDigest ? { beforeDigest: input.beforeDigest } : {}),
      result: 'intent',
      metadata: input.metadata ?? {},
    });
  } catch (error) {
    if (error instanceof GovernanceAuditUnavailableError) throw error;
    throw new GovernanceAuditUnavailableError(
      `治理审计写入失败，高风险操作已阻止: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function recordGovernanceOutcome(
  store: GovernanceAuditStore,
  intent: GovernanceAuditEvent,
  result: 'succeeded' | 'failed',
  input: { afterDigest?: string; metadata?: GovernanceAuditMetadata; reason?: string } = {},
): Promise<GovernanceAuditEvent> {
  return await store.append({
    correlationId: intent.correlationId,
    changeId: intent.auditId,
    actorType: intent.actorType,
    actorUserId: intent.actorUserId,
    actorPersona: intent.actorPersona,
    ...(intent.actorTenantId ? { actorTenantId: intent.actorTenantId } : {}),
    action: intent.action,
    targetType: intent.targetType,
    targetId: intent.targetId,
    ...(intent.targetTenantId ? { targetTenantId: intent.targetTenantId } : {}),
    purpose: intent.purpose,
    ...(input.reason ?? intent.reason ? { reason: input.reason ?? intent.reason } : {}),
    ...(intent.beforeDigest ? { beforeDigest: intent.beforeDigest } : {}),
    ...(input.afterDigest ? { afterDigest: input.afterDigest } : {}),
    result,
    metadata: input.metadata ?? {},
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}
