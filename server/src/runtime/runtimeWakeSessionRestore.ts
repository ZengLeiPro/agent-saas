import type { AgentProfileBindingKey } from '../data/agentProfiles/types.js';
import type { RunRecord } from './runStore.js';
import type { RuntimeSessionRecord, SessionCatalog } from './sessionCatalog.js';

const PROFILE_BINDING_KEYS = new Set<AgentProfileBindingKey>([
  'main',
  'org_agent',
  'memory_poll',
  'subagent_general',
  'subagent_explore',
  'background_general',
  'background_explore',
]);
const PROFILE_RESOLUTIONS = new Set(['database', 'builtin', 'compatibility']);

/**
 * Session meta 仍是文件投影；部署重启或跨 worker 时可能暂时缺失。Run row 才是
 * scheduler 的 durable 恢复源，因此首跑必须把重建 Session 所需字段写入 metadata。
 */
export async function restoreRuntimeSessionForWake(
  catalog: SessionCatalog,
  run: RunRecord,
): Promise<RuntimeSessionRecord | null> {
  const existing = await catalog.get(run.sessionId);
  if (existing) {
    const durableIdentity = {
      userId: stringValue(run.userId),
      tenantId: stringValue(run.tenantId),
      orgAgentId: stringValue(run.metadata.orgAgentId),
    };
    assertCompatibleIdentity('userId', existing.userId, durableIdentity.userId);
    assertCompatibleIdentity('tenantId', existing.tenantId, durableIdentity.tenantId);
    assertCompatibleIdentity('orgAgentId', existing.orgAgentId, durableIdentity.orgAgentId);

    const repaired: RuntimeSessionRecord = {
      ...existing,
      userId: existing.userId || durableIdentity.userId || '',
      ...(!existing.tenantId && durableIdentity.tenantId ? { tenantId: durableIdentity.tenantId } : {}),
      ...(!existing.orgAgentId && durableIdentity.orgAgentId ? { orgAgentId: durableIdentity.orgAgentId } : {}),
    };
    const changed = repaired.userId !== existing.userId
      || repaired.tenantId !== existing.tenantId
      || repaired.orgAgentId !== existing.orgAgentId;
    if (!changed) return existing;
    const updatedAt = new Date().toISOString();
    if (catalog.backfillIdentity) {
      return catalog.backfillIdentity(run.sessionId, {
        ...durableIdentity,
        updatedAt,
      });
    }
    repaired.updatedAt = updatedAt;
    await catalog.upsert(repaired);
    return repaired;
  }

  const metadata = run.metadata;
  const cwd = stringValue(metadata.cwd);
  const transcriptPath = stringValue(metadata.transcriptPath);
  const username = stringValue(metadata.username);
  const channel = run.channel;
  if (!cwd || !transcriptPath || !username || !channel) return null;

  const now = new Date().toISOString();
  const record: RuntimeSessionRecord = {
    sessionId: run.sessionId,
    userId: run.userId ?? '',
    username,
    ...(isUserRole(metadata.userRole) ? { userRole: metadata.userRole } : {}),
    ...(run.tenantId ? { tenantId: run.tenantId } : {}),
    channel,
    cwd,
    transcriptPath,
    ...(stringValue(metadata.modelRef) ? { modelRef: stringValue(metadata.modelRef)! } : {}),
    ...(run.executionTarget ? { executionTarget: run.executionTarget } : {}),
    workspaceId: run.workspaceId ?? run.sessionId,
    status: 'running',
    ...(stringValue(metadata.orgAgentId) ? { orgAgentId: stringValue(metadata.orgAgentId)! } : {}),
    ...profileBinding(metadata.profile),
    createdAt: run.requestedAt || now,
    updatedAt: now,
  };
  await catalog.upsert(record);
  return record;
}

function profileBinding(value: unknown): Partial<RuntimeSessionRecord> {
  if (!isRecord(value)) return {};
  const profileId = stringValue(value.profileId);
  const profileKey = stringValue(value.profileKey);
  const profileVersionId = stringValue(value.profileVersionId);
  const profileConfigDigest = stringValue(value.configDigest);
  const profileBindingKey = stringValue(value.bindingKey);
  const profileResolution = stringValue(value.resolution);
  if (!profileId || !profileKey || !profileVersionId || !profileConfigDigest
    || !profileBindingKey || !PROFILE_BINDING_KEYS.has(profileBindingKey as AgentProfileBindingKey)
    || !profileResolution || !PROFILE_RESOLUTIONS.has(profileResolution)
    || !Number.isInteger(value.versionNumber)) return {};
  return {
    profileId,
    profileKey,
    profileVersionId,
    profileVersionNumber: value.versionNumber as number,
    profileConfigDigest,
    profileBindingKey: profileBindingKey as AgentProfileBindingKey,
    profileResolution: profileResolution as 'database' | 'builtin' | 'compatibility',
  };
}

function assertCompatibleIdentity(
  field: string,
  existing: string | undefined,
  durable: string | undefined,
): void {
  if (existing && durable && existing !== durable) {
    throw new Error(`WAKE_SESSION_IDENTITY_CONFLICT:${field}`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isUserRole(value: unknown): value is 'admin' | 'user' {
  return value === 'admin' || value === 'user';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
