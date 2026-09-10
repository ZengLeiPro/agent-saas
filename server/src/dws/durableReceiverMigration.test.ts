import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import { DurableDwsReceiverMigrationService } from './durableReceiverMigration.js';

const account: AgentDwsAccountRecord = {
  accountId: 'account-one',
  tenantId: 'tenant-one',
  agentId: 'agent-one',
  displayName: '接收器',
  loginId: 'receiver',
  corpId: 'corp',
  dingtalkUserId: 'user',
  profileId: 'corp:user',
  status: 'active',
  runtimeStatus: 'ready',
  deliveryProtocol: 'legacy',
  eventKinds: ['at_me'],
  revision: 7,
  identityUpdatedAt: '2026-09-10T00:00:00.000Z',
  createdAt: '2026-09-10T00:00:00.000Z',
  createdBy: 'admin',
  updatedAt: '2026-09-10T00:00:00.000Z',
  updatedBy: 'admin',
};

describe('DurableDwsReceiverMigrationService', () => {
  let state: 'planned' | 'handoff_pending' | 'blocked' | 'activated';
  let store: Record<string, ReturnType<typeof vi.fn>>;
  let bridge: Record<string, ReturnType<typeof vi.fn>>;
  let legacyGateway: Record<string, ReturnType<typeof vi.fn>>;
  let durableGateway: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    state = 'planned';
    store = {
      prepareMigration: vi.fn(async () => ({
        migrationId: 'migration-one',
        accountId: account.accountId,
        tenantId: account.tenantId,
        expectedRevision: account.revision,
        state,
        evidence: {},
      })),
      beginMigration: vi.fn(async () => ({
        migrationId: 'migration-one',
        accountId: account.accountId,
        tenantId: account.tenantId,
        expectedRevision: account.revision,
        state: (state = 'handoff_pending'),
        evidence: {},
      })),
      activateMigration: vi.fn(async () => ({
        migrationId: 'migration-one',
        accountId: account.accountId,
        tenantId: account.tenantId,
        expectedRevision: account.revision,
        state: (state = 'activated'),
        evidence: {},
      })),
      blockMigration: vi.fn(async () => {
        state = 'blocked';
      }),
      migration: vi.fn(),
      diagnostics: vi.fn(),
      abortPlannedMigration: vi.fn(),
    };
    bridge = {
      capabilities: vi.fn(async () => ({
        protocolVersion: 1,
        ownershipReaders: 1,
        durableReceiver: 1,
        upstreamReplay: 'unverified',
        minimumRollbackProtocol: 1,
        sourceSha: 'source-sha',
      })),
      stopAndProve: vi.fn(async () => ({
        invocationId: 'agent-dws-events-account-one',
        provenance: 'journal',
        operations: [
          {
            operationId: 'operation-one',
            attemptId: 'attempt-one',
            resource: 'stopped',
            updatedAt: '2026-09-10T00:01:00.000Z',
          },
        ],
      })),
    };
    legacyGateway = { stopAccount: vi.fn(async () => undefined) };
    durableGateway = { startAccount: vi.fn(async () => undefined) };
  });

  function service() {
    return new DurableDwsReceiverMigrationService({
      agentCwd: '/srv/agent',
      accountStore: {
        getForTenant: vi.fn(async () => ({
          ...account,
          revision: state === 'planned' ? 7 : state === 'activated' ? 9 : 8,
          deliveryProtocol:
            state === 'activated'
              ? 'durable-v1'
              : state === 'planned'
                ? 'legacy'
                : 'handoff_pending',
        })),
      } as never,
      deliveryStore: store as never,
      legacyGateway: legacyGateway as never,
      durableGateway: durableGateway as never,
      bridge: bridge as never,
    });
  }

  it('activates only after the exact legacy journal proof', async () => {
    await expect(
      service().activate(account.tenantId, account.accountId, 7, 'admin'),
    ).resolves.toMatchObject({ state: 'activated' });
    expect(store.beginMigration).toHaveBeenCalledBefore(bridge.stopAndProve);
    expect(bridge.stopAndProve).toHaveBeenCalledBefore(store.activateMigration);
    expect(store.activateMigration.mock.calls[0]?.[1]).toMatchObject({
      legacyStopProof: { provenance: 'journal', operations: [{ resource: 'stopped' }] },
      minimumRollbackProtocol: 1,
    });
  });

  it('keeps handoff_pending blocked when exact stop proof is unavailable', async () => {
    bridge.stopAndProve.mockRejectedValueOnce(new Error('legacy_stop_proof_unavailable'));
    await expect(
      service().activate(account.tenantId, account.accountId, 7, 'admin'),
    ).rejects.toThrow('legacy_stop_proof_unavailable');
    expect(store.activateMigration).not.toHaveBeenCalled();
    expect(store.blockMigration).toHaveBeenCalledWith(
      'migration-one',
      expect.objectContaining({
        blocker: 'legacy_stop_proof_unavailable',
      }),
    );
  });
});
