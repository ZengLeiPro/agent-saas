import { describe, expect, it, vi } from 'vitest';

import { persistedInteractionAccessError } from '../channels/web/persistedInteractionAccess.js';
import type { RunRecord } from '../runtime/runStore.js';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'cancelled',
    tenantId: 'tenant-a',
    userId: 'user-a',
    requestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { orgAgentId: 'agent-a' },
    ...overrides,
  } as RunRecord;
}

const orgAgentAccessError = vi.fn(() => undefined);

describe('persistedInteractionAccessError', () => {
  it('allows the source owner when transcript metadata is unavailable', () => {
    expect(persistedInteractionAccessError({
      sessionId: 'session-1',
      user: { sub: 'user-a', username: 'user-a', role: 'user', tenantId: 'tenant-a' },
      sourceRun: run(),
      orgAgentAccessError,
    })).toBeUndefined();
  });

  it('denies a different non-admin owner', () => {
    expect(persistedInteractionAccessError({
      sessionId: 'session-1',
      user: { sub: 'user-b', username: 'user-b', role: 'user', tenantId: 'tenant-a' },
      sourceRun: run(),
      orgAgentAccessError,
    })).toBe('Access denied');
  });

  it('denies a tenant admin from another tenant', () => {
    expect(persistedInteractionAccessError({
      sessionId: 'session-1',
      user: { sub: 'admin-b', username: 'admin-b', role: 'admin', tenantId: 'tenant-b' },
      sourceRun: run(),
      orgAgentAccessError,
    })).toBe('Access denied');
  });

  it('denies a source run from another session', () => {
    expect(persistedInteractionAccessError({
      sessionId: 'session-other',
      user: { sub: 'user-a', username: 'user-a', role: 'user', tenantId: 'tenant-a' },
      sourceRun: run(),
      orgAgentAccessError,
    })).toBe('Access denied');
  });

  it('denies transcript metadata that conflicts with the source run', () => {
    expect(persistedInteractionAccessError({
      sessionId: 'session-1',
      user: { sub: 'user-a', username: 'user-a', role: 'user', tenantId: 'tenant-a' },
      meta: { tenantId: 'tenant-b', userId: 'user-a' } as any,
      sourceRun: run(),
      orgAgentAccessError,
    })).toBe('Access denied');
  });

  it('passes run-backed org-agent identity to the final governance check', () => {
    const check = vi.fn(() => '该企业专家当前不可用，请联系组织管理员');
    expect(persistedInteractionAccessError({
      sessionId: 'session-1',
      user: { sub: 'user-a', username: 'user-a', role: 'user', tenantId: 'tenant-a' },
      sourceRun: run(),
      orgAgentAccessError: check,
    })).toBe('该企业专家当前不可用，请联系组织管理员');
    expect(check).toHaveBeenCalledWith('agent-a', 'tenant-a', undefined);
  });
});
