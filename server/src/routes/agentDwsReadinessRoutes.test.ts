import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FakeAccountStore,
  listenForAgentDwsAccountRoutes,
  makeAccount,
  makeGroupBinding,
} from '../__tests__/agentDwsAccountsRoutes.fixtures.js';

describe('Agent DWS readiness route isolation', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  it('群工作台只诊断当前身份且 readiness 不回显租户与身份 ID', async () => {
    const store = new FakeAccountStore();
    store.records.push(
      makeAccount({
        status: 'active',
        runtimeStatus: 'ready',
        runtimeLeaseActive: true,
        profileId: 'corp-a:ding-a',
        corpId: 'corp-a',
        dingtalkUserId: 'ding-a',
      }),
    );
    const currentBase = makeGroupBinding();
    const current = makeGroupBinding({
      effectiveConfig: {
        ...currentBase.effectiveConfig,
        capabilities: { skillIds: ['skill-ready'], toolNames: [], dwsResourceIds: [] },
      },
    });
    const stale = makeGroupBinding({
      bindingId: 'binding-stale-secret',
      conversationId: 'conversation-stale-secret',
      accountIdentity: {
        profileId: 'corp-old:user-old',
        corpId: 'corp-old',
        dingtalkUserId: 'user-old',
        identityUpdatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const opened = await listenForAgentDwsAccountRoutes({
      store,
      orgGroupAgentStore: {
        listBindings: vi.fn(async () => [current, stale]),
        listDeliveries: vi.fn(async () => []),
        loadGroupWorkspace: vi.fn(async () => ({
          conversations: [],
          workOrders: [],
          attempts: [],
          memories: [],
        })),
      } as never,
      orgAgentStore: {
        get: vi.fn(() => ({
          id: 'oa-sales',
          tenantId: 'tenant-a',
          enabled: true,
          allowedSkills: ['skill-ready'],
          allowedKnowledge: [],
          runtime: { executionMode: 'dispatcher' },
        })),
      } as never,
    });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      bindings: Array<{ bindingId: string; readiness: unknown }>;
    };
    expect(body.bindings.map((binding) => binding.bindingId)).toEqual(['binding-a']);
    const readiness = JSON.stringify(body.bindings[0]?.readiness);
    expect(readiness).toContain('"status":"ready"');
    expect(readiness).not.toMatch(/tenant-a|corp-a|ding-a|adws-1|oa-sales/);
    expect(JSON.stringify(body)).not.toMatch(/stale-secret|corp-old|user-old/);
  });
});
