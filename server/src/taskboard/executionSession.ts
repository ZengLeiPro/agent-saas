import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import {
  createRuntimeSessionRecord,
  type RuntimeSessionRecord,
  type SessionCatalog,
} from '../runtime/sessionCatalog.js';
import { deriveStableWorkspaceId } from '../runtime/workspaceIdentity.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { TaskboardExecutionUnavailableError, type TaskboardIdentity } from './types.js';

export async function reuseTaskboardSession(input: {
  sessionCatalog: SessionCatalog;
  agentCwd: string;
  sessionId: string;
  executionIdentity: TaskboardIdentity;
  modelRef: string;
  executionTarget: ExecutionTargetKind;
}): Promise<RuntimeSessionRecord> {
  const {
    sessionCatalog,
    agentCwd,
    sessionId,
    executionIdentity,
    modelRef,
    executionTarget,
  } = input;
  const existing = await sessionCatalog.get(sessionId);
  if (existing && (
    existing.userId !== executionIdentity.ownerUserId
    || (existing.tenantId && existing.tenantId !== executionIdentity.tenantId)
  )) {
    throw new TaskboardExecutionUnavailableError('任务既有会话归属不匹配，拒绝复用');
  }
  const workspaceUser = {
    id: executionIdentity.ownerUserId,
    username: executionIdentity.username,
    role: executionIdentity.userRole ?? 'user' as const,
    tenantId: executionIdentity.tenantId,
  };
  const fresh = createRuntimeSessionRecord({
    sessionId,
    userId: executionIdentity.ownerUserId,
    username: executionIdentity.username,
    userRole: executionIdentity.userRole,
    tenantId: executionIdentity.tenantId,
    channel: 'web',
    cwd: resolveUserCwd(agentCwd, workspaceUser),
    modelRef,
    executionTarget,
    workspaceId: deriveStableWorkspaceId(workspaceUser, sessionId),
    status: 'running',
  });
  if (!existing) return fresh;
  return {
    ...existing,
    username: existing.username || executionIdentity.username,
    userRole: executionIdentity.userRole,
    modelRef,
    executionTarget,
    workspaceId: existing.workspaceId ?? deriveStableWorkspaceId(workspaceUser, sessionId),
    status: 'running',
    updatedAt: new Date().toISOString(),
  };
}
