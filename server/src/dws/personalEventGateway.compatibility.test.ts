import { describe, expect, it, vi } from 'vitest';
import { DwsPersonalEventGateway } from './personalEventGateway.js';
import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';

function fixture(extra: Record<string, unknown>): AgentDwsAccountRecord {
  return {
    accountId: 'adws-test', tenantId: 'tenant-test', agentId: 'agent-test',
    displayName: 'Test', loginId: 'test', profileId: 'corp:user', corpId: 'corp', dingtalkUserId: 'user',
    status: 'active', runtimeStatus: 'stopped', eventKinds: ['at_me'], revision: 2,
    createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
    createdBy: 'test', updatedBy: 'test', ...extra,
  } as AgentDwsAccountRecord;
}

describe('R19 R26 actual DWS legacy-reader compatibility', () => {
  it.each(['durable-v1', 'handoff_pending', 'future-v7'])('does not acquire a legacy owner for delivery protocol %s', async (deliveryProtocol) => {
    const claimRuntimeLease = vi.fn(async () => false);
    const resolveServerRemote = vi.fn(async () => ({ baseUrl: 'https://must-not-contact.invalid', authToken: 'test-only' }));
    const accountStore = {
      claimRuntimeLease, releaseRuntimeLease: vi.fn(async () => undefined),
    } as unknown as AgentDwsAccountStore;
    const gateway = new DwsPersonalEventGateway({ agentCwd: '/test-only', accountStore, resolveServerRemote });
    try {
      await gateway.startAccount(fixture({ deliveryProtocol }));
      expect(claimRuntimeLease).not.toHaveBeenCalled();
      expect(resolveServerRemote).not.toHaveBeenCalled();
    } finally { await gateway.stop(); }
  });

  it('does not start the newly authorized identity while old-stream cleanup is unconfirmed', async () => {
    const claimRuntimeLease = vi.fn(async () => false);
    const gateway = new DwsPersonalEventGateway({
      agentCwd: '/test-only',
      accountStore: { claimRuntimeLease, releaseRuntimeLease: vi.fn(async () => undefined) } as unknown as AgentDwsAccountStore,
      resolveServerRemote: vi.fn(async () => ({ baseUrl: 'https://must-not-contact.invalid', authToken: 'test-only' })),
    });
    try {
      await gateway.startAccount(fixture({ identityCleanupPending: {
        previous: { profileId: 'corp:old', corpId: 'corp', dingtalkUserId: 'old', identityUpdatedAt: '2026-09-08T00:00:00Z' },
        streamStopped: false, contextInvalidated: false,
      } }));
      expect(claimRuntimeLease).not.toHaveBeenCalled();
    } finally { await gateway.stop(); }
  });
});
