import { createHash } from 'node:crypto';

export const RUNTIME_ISOLATION_POLICY_DIGEST = createHash('sha256')
  .update('integration-v3-runtime-isolation:v1:acs-network-policy:private+metadata+dns-rebinding-blocked')
  .digest('hex');

export const RUNTIME_ISOLATION_EVIDENCE_TTL_MS = 60_000;

export interface RuntimeIsolationRequirement {
  tenantId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  workspaceId: string;
  policyDigest: string;
}

export interface RuntimeIsolationEvidence extends RuntimeIsolationRequirement {
  sandboxName: string;
  sandboxScopeId: string;
  issuedAt: string;
  expiresAt: string;
}

export function deriveRuntimeIsolationRequirement(
  parent: RuntimeIsolationRequirement | undefined,
  child: { runId: string; sessionId: string; workspaceId: string },
): RuntimeIsolationRequirement | undefined {
  if (!parent) return undefined;
  return { ...parent, ...child };
}

export function integrationRuntimeIsolationRequirement(
  metadata: Record<string, unknown> | undefined,
  input: { tenantId?: string; runId: string; sessionId: string; workspaceId: string },
): RuntimeIsolationRequirement | undefined {
  const role = typeof metadata?.taskboardIntegrationRole === 'string'
    ? metadata.taskboardIntegrationRole.toLowerCase()
    : '';
  const required = metadata?.taskboardIntegration === true && (role === 'work' || role === 'review');
  if (!required) return undefined;
  const taskId = typeof metadata?.taskboardIntegrationTaskId === 'string'
    ? metadata.taskboardIntegrationTaskId.trim()
    : '';
  if (!input.tenantId?.trim() || !taskId) {
    throw new Error('RUNTIME_ISOLATION_REQUIREMENT_IDENTITY_MISSING');
  }
  return {
    tenantId: input.tenantId,
    taskId,
    runId: input.runId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
  };
}

export function assertRuntimeIsolationEvidence(input: {
  requirement: RuntimeIsolationRequirement;
  evidence: unknown;
  sandboxScopeId: string;
  nowMs?: number;
}): asserts input is { requirement: RuntimeIsolationRequirement; evidence: RuntimeIsolationEvidence; sandboxScopeId: string; nowMs?: number } {
  if (!isRecord(input.evidence)) throw new Error('RUNTIME_ISOLATION_EVIDENCE_MISSING');
  const evidence = input.evidence;
  for (const field of ['tenantId', 'taskId', 'runId', 'sessionId', 'workspaceId', 'policyDigest'] as const) {
    if (evidence[field] !== input.requirement[field]) {
      throw new Error(`RUNTIME_ISOLATION_EVIDENCE_BINDING_MISMATCH:${field}`);
    }
  }
  if (evidence.sandboxScopeId !== input.sandboxScopeId) {
    throw new Error('RUNTIME_ISOLATION_EVIDENCE_BINDING_MISMATCH:sandboxScopeId');
  }
  if (typeof evidence.sandboxName !== 'string' || !/^as-[a-z0-9-]{1,60}$/.test(evidence.sandboxName)) {
    throw new Error('RUNTIME_ISOLATION_EVIDENCE_INVALID:sandboxName');
  }
  if (typeof evidence.issuedAt !== 'string' || typeof evidence.expiresAt !== 'string') {
    throw new Error('RUNTIME_ISOLATION_EVIDENCE_INVALID:time');
  }
  const issuedAt = Date.parse(evidence.issuedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > now + 5_000 || expiresAt <= now || expiresAt - issuedAt > RUNTIME_ISOLATION_EVIDENCE_TTL_MS) {
    throw new Error('RUNTIME_ISOLATION_EVIDENCE_EXPIRED');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
