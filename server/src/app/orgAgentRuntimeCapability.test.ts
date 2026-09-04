import { describe, expect, it, vi } from 'vitest';

import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import { createOrgAgentRuntimeCapabilityProbe } from './orgAgentRuntimeCapability.js';

const account = {
  accountId: 'account-a',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  displayName: '专家甲',
  loginId: 'login-a',
  status: 'active',
  runtimeStatus: 'ready',
  eventKinds: ['at_me'],
  revision: 1,
  createdAt: '2026-09-04T00:00:00.000Z',
  createdBy: 'admin-a',
  updatedAt: '2026-09-04T00:00:00.000Z',
  updatedBy: 'admin-a',
} satisfies AgentDwsAccountRecord;

describe('organization Agent runtime capability probe', () => {
  it('requires both the active Worker marker and the ACS shared-mount capability', async () => {
    const workerReady = vi.fn(() => true);
    const health = vi.fn(async () => ({
      status: 'ok' as const,
      metadata: { capabilities: { sharedReadOnlyMount: { available: true, protocolVersion: 1 } } },
    }));
    const probe = createOrgAgentRuntimeCapabilityProbe({
      isRuntimeWorkerV2Ready: workerReady,
      resolveServerRemote: vi.fn(async () => ({
        baseUrl: 'https://acs.test',
        authToken: 'secret',
      })),
      ttlMs: 0,
      createTransport: () => ({ health }),
    });

    await expect(probe(account)).resolves.toBe(true);
    workerReady.mockReturnValue(false);
    await expect(probe(account)).resolves.toBe(false);
  });

  it('fails closed for legacy ACS health payloads and probe failures', async () => {
    const legacy = createOrgAgentRuntimeCapabilityProbe({
      isRuntimeWorkerV2Ready: () => true,
      resolveServerRemote: async () => ({ baseUrl: 'https://legacy.test', authToken: 'secret' }),
      ttlMs: 0,
      createTransport: () => ({
        health: async () => ({ status: 'ok', metadata: { capabilities: {} } }),
      }),
    });
    const unavailable = createOrgAgentRuntimeCapabilityProbe({
      isRuntimeWorkerV2Ready: () => true,
      resolveServerRemote: async () => {
        throw new Error('unavailable');
      },
    });

    await expect(legacy(account)).resolves.toBe(false);
    await expect(unavailable(account)).resolves.toBe(false);
  });
});
