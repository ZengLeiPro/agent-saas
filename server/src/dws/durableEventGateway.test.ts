import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import type {
  DwsDeliverySession,
  PgDwsDeliveryStore,
} from '../data/agentDwsAccounts/durableDeliveryStore.js';
import type { DwsReceiverClient } from './dwsReceiverClient.js';
import { DurableDwsEventGateway } from './durableEventGateway.js';

const account = {
  accountId: 'account-one',
  tenantId: 'tenant-one',
  agentId: 'agent-one',
  displayName: 'fixture',
  loginId: 'fixture',
  revision: 3,
  status: 'active',
  profileId: 'corp:user',
  corpId: 'corp',
  dingtalkUserId: 'user',
  eventKinds: ['at_me'],
  identityUpdatedAt: '2026-09-10T00:00:00.000Z',
  deliveryProtocol: 'durable-v1',
  runtimeStatus: 'starting',
  createdAt: '2026-09-10T00:00:00.000Z',
  createdBy: 'fixture',
  updatedAt: '2026-09-10T00:00:00.000Z',
  updatedBy: 'fixture',
} as AgentDwsAccountRecord;
const session: DwsDeliverySession = {
  owner: {
    tenantId: account.tenantId,
    accountId: account.accountId,
    receiverId: 'drx-fixture',
    ownerId: 'consumer-one',
    epoch: '1',
    revision: account.revision,
    expiresAtMs: Date.now() + 60_000,
  },
  source: {
    accountId: account.accountId,
    receiverId: 'drx-fixture',
    profileId: account.profileId!,
    identityUpdatedAt: account.identityUpdatedAt!,
    eventKinds: ['at_me'],
  },
  workspace: {
    id: 'workspace-one',
    sessionId: 'session-one',
    sandboxScopeId: 'scope-one',
    mountSubPath: 'fixtures/dws',
  },
  receivedCursor: 0,
  acknowledgedCursor: 0,
  state: 'registered',
};

function snapshot(acknowledgedSequence = 0, records?: unknown[]) {
  return {
    protocolVersion: 1 as const,
    accountId: account.accountId,
    receiverId: session.owner.receiverId,
    podUid: 'pod-one',
    ownerEpoch: session.owner.epoch,
    state: 'running' as const,
    highestSequence: records?.length ? 1 : acknowledgedSequence,
    acknowledgedSequence,
    sourceReady: true,
    sourceAlive: true,
    upstreamReplay: 'unverified' as const,
    needsReconciliation: false,
    ...(records ? { records } : {}),
  };
}

describe('DurableDwsEventGateway', () => {
  it('persists raw intake, commits through the existing router, then advances remote and local ACK', async () => {
    const order: string[] = [];
    const payload = Buffer.from(
      JSON.stringify({
        event_id: 'event-one',
        type: 'user_im_message_receive_at',
        conversation_id: 'conversation-one',
        content: 'hello',
      }),
    );
    const frame = {
      sequence: 1,
      payloadBase64: payload.toString('base64'),
      sha256: createHash('sha256').update(payload).digest('hex'),
      receivedAtMs: Date.now(),
    };
    let read = false;
    const control = vi.fn(async (action: string) => {
      if (action === 'read' && !read) {
        read = true;
        return snapshot(0, [frame]);
      }
      if (action === 'ack') {
        order.push('remote-ack');
        return snapshot(1);
      }
      return snapshot(0);
    });
    const deliveryStore = {
      claim: vi.fn(async () => session),
      renew: vi.fn(async () => session.owner),
      accept: vi.fn(async () => {
        order.push('raw-commit');
        return 1;
      }),
      pending: vi.fn(async () =>
        read ? [{ sequence: 1, bytes: payload, identity: session.source }] : [],
      ),
      forwarded: vi.fn(async () => {
        order.push('business-commit');
      }),
      markEvent: vi.fn(async () => undefined),
      ackableCursor: vi.fn(async () => (order.includes('business-commit') ? 1 : 0)),
      acknowledged: vi.fn(async () => {
        order.push('local-ack');
      }),
      updateRuntimeStatus: vi.fn(async () => undefined),
      recordBlocker: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    } as unknown as PgDwsDeliveryStore;
    const gateway = new DurableDwsEventGateway({
      accountStore: {
        listRunnable: vi.fn(async () => []),
        listForTenant: vi.fn(async () => []),
      } as any,
      deliveryStore,
      clientFor: vi.fn(
        async () =>
          ({ capabilities: vi.fn(async () => ({})), control }) as unknown as DwsReceiverClient,
      ),
      onEvent: vi.fn(async () => {
        order.push('router-ingest');
      }),
    });

    await gateway.startAccount(account);
    await vi.waitFor(() => expect(order).toContain('local-ack'));
    await gateway.stop();
    expect(order).toEqual([
      'raw-commit',
      'router-ingest',
      'business-commit',
      'remote-ack',
      'local-ack',
    ]);
  });

  it('normal Server shutdown detaches the consumer without stopping the remote source', async () => {
    const control = vi.fn(async (_action: string) => snapshot(0));
    const deliveryStore = {
      claim: vi.fn(async () => session),
      renew: vi.fn(async () => session.owner),
      pending: vi.fn(async () => []),
      ackableCursor: vi.fn(async () => 0),
      updateRuntimeStatus: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      recordBlocker: vi.fn(async () => undefined),
    } as unknown as PgDwsDeliveryStore;
    const gateway = new DurableDwsEventGateway({
      accountStore: {
        listRunnable: vi.fn(async () => []),
        listForTenant: vi.fn(async () => []),
      } as any,
      deliveryStore,
      clientFor: vi.fn(
        async () =>
          ({ capabilities: vi.fn(async () => ({})), control }) as unknown as DwsReceiverClient,
      ),
      onEvent: vi.fn(async () => undefined),
    });
    await gateway.startAccount(account);
    await vi.waitFor(() =>
      expect(control).toHaveBeenCalledWith(
        'status',
        expect.anything(),
        {},
        expect.any(AbortSignal),
      ),
    );
    await gateway.stop();
    expect(control.mock.calls.some((call) => call[0] === 'stop')).toBe(false);
    expect(deliveryStore.release).toHaveBeenCalledWith(session.owner);
  });
});
