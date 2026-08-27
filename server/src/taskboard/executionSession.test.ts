import { describe, expect, it, vi } from 'vitest';

import type { RuntimeSessionRecord, SessionCatalog } from '../runtime/sessionCatalog.js';
import { reuseTaskboardSession } from './executionSession.js';

const identity = {
  tenantId: 'tenant-1',
  ownerUserId: 'owner-1',
  username: 'owner',
  userRole: 'admin' as const,
};

function catalogWith(existing: RuntimeSessionRecord): SessionCatalog {
  return {
    get: vi.fn(async () => existing),
    upsert: vi.fn(),
    ensure: vi.fn(),
    markStatus: vi.fn(),
    findTranscriptPath: vi.fn(),
  };
}

function legacySession(overrides: Partial<RuntimeSessionRecord> = {}): RuntimeSessionRecord {
  return {
    sessionId: 'taskboard-integration-work-session-1',
    userId: identity.ownerUserId,
    username: identity.username,
    channel: 'web',
    cwd: '/workspace/owner',
    transcriptPath: '/workspace/owner/transcript.jsonl',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

async function reuse(existing: RuntimeSessionRecord) {
  return reuseTaskboardSession({
    sessionCatalog: catalogWith(existing),
    agentCwd: '/workspace',
    sessionId: existing.sessionId,
    executionIdentity: identity,
    modelRef: 'codex/gpt-5.6-terra-high',
    executionTarget: 'server-container',
  });
}

describe('reuseTaskboardSession', () => {
  it('backfills the execution tenant when reusing a legacy session without tenant identity', async () => {
    await expect(reuse(legacySession())).resolves.toMatchObject({
      tenantId: identity.tenantId,
      sessionSource: 'taskboard_execution',
      sandboxProfile: 'coding',
      memoryAutomationEligible: false,
    });
  });

  it('rejects an existing session owned by another tenant', async () => {
    await expect(reuse(legacySession({ tenantId: 'tenant-2' })))
      .rejects.toThrow('任务既有会话归属不匹配，拒绝复用');
  });
});
