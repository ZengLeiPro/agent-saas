import type { AgentProfileBindingKey } from '../data/agentProfiles/types.js';
import type { RunRecord, RunStore } from './runStore.js';
import { parseSandboxWorkloadDescriptor, type RuntimeSessionRecord, type SessionCatalog } from './sessionCatalog.js';
import type { RuntimeWakeLease } from './runtimeWakeLeaseLifecycle.js';

const PROFILE_BINDING_KEYS = new Set<AgentProfileBindingKey>([
  'main',
  'org_agent',
  'memory_poll',
  'memory_consolidate',
  'subagent_general',
  'subagent_explore',
  'background_general',
  'background_explore',
]);
const PROFILE_RESOLUTIONS = new Set(['database', 'builtin', 'compatibility']);

export function deletedSessionResumeError(sessionId: string) {
  return { type: 'error' as const, error: `Session ${sessionId} 已删除，请先显式恢复会话` };
}

export async function cancelDeletedSessionWake(
  run: RunRecord,
  lease: Pick<RuntimeWakeLease, 'release'> | undefined,
  runStore: Pick<RunStore, 'markStatus'> | undefined,
): Promise<void> {
  const reason = 'session_deleted_before_wake';
  if (lease) await lease.release('cancelled', reason);
  else await runStore?.markStatus(run.runId, 'cancelled', reason);
}

export async function cancelDeletedSessionWakeIfPresent(
  catalog: SessionCatalog,
  run: RunRecord,
  lease: Pick<RuntimeWakeLease, 'release'> | undefined,
  runStore: Pick<RunStore, 'markStatus'> | undefined,
): Promise<boolean> {
  if (!(await catalog.get(run.sessionId))?.deletedAt) return false;
  await cancelDeletedSessionWake(run, lease, runStore);
  return true;
}

/**
 * Session meta 仍是文件投影；部署重启或跨 worker 时可能暂时缺失。Run row 才是
 * scheduler 的 durable 恢复源，首跑必须把重建 Session 所需字段写入 metadata。
 */
export async function restoreRuntimeSessionForWake(
  catalog: SessionCatalog,
  run: RunRecord,
): Promise<RuntimeSessionRecord | null> {
  const metadata = run.metadata;
  const workload = parseSandboxWorkloadDescriptor(metadata.sandboxWorkloadDescriptor);
  const existing = await catalog.get(run.sessionId);
  if (existing?.deletedAt) return existing;
  if (existing) {
    const durableIdentity = {
      userId: stringValue(run.userId),
      tenantId: stringValue(run.tenantId),
      orgAgentId: stringValue(run.metadata.orgAgentId),
    };
    assertCompatibleIdentity('userId', existing.userId, durableIdentity.userId);
    assertCompatibleIdentity('tenantId', existing.tenantId, durableIdentity.tenantId);
    assertCompatibleIdentity('orgAgentId', existing.orgAgentId, durableIdentity.orgAgentId);

    const workloadChanged = !existing.sandboxWorkloadDescriptor && Boolean(workload);
    const repaired: RuntimeSessionRecord = {
      ...existing,
      userId: existing.userId || durableIdentity.userId || '',
      ...(!existing.tenantId && durableIdentity.tenantId ? { tenantId: durableIdentity.tenantId } : {}),
      ...(!existing.orgAgentId && durableIdentity.orgAgentId ? { orgAgentId: durableIdentity.orgAgentId } : {}),
      ...(workloadChanged ? { sandboxWorkloadDescriptor: workload! } : {}),
    };
    const identityChanged = repaired.userId !== existing.userId
      || repaired.tenantId !== existing.tenantId
      || repaired.orgAgentId !== existing.orgAgentId;
    if (!identityChanged && !workloadChanged) return existing;
    const updatedAt = new Date().toISOString();
    if (identityChanged && catalog.backfillIdentity) {
      const backfilled = await catalog.backfillIdentity(run.sessionId, { ...durableIdentity, updatedAt });
      if (!backfilled || !workloadChanged) return backfilled;
      const withWorkload = { ...backfilled, sandboxWorkloadDescriptor: workload!, updatedAt };
      await catalog.upsert(withWorkload);
      return withWorkload;
    }
    repaired.updatedAt = updatedAt;
    await catalog.upsert(repaired);
    return repaired;
  }

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
    ...(workload ? { sandboxWorkloadDescriptor: workload } : {}),
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
