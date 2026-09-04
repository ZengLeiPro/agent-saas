import { describe, expect, it, vi } from 'vitest';

import type { OrgAgentWorkOrder, OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import { resolveOrgAgentConversationRouteHint } from './orgAgentConversationRouting.js';

describe('resolveOrgAgentConversationRouteHint', () => {
  it('显式 W 短号只路由到同绑定且当前调用者可见的任务', async () => {
    const work = {
      workOrderId: 'work-a',
      shortId: 'W-ABCDEF123456',
      bindingId: 'binding-a',
      visibility: 'conversation',
    } as OrgAgentWorkOrder;
    const store = {
      getWorkOrderByShortId: vi.fn().mockResolvedValue(work),
    } as unknown as OrgGroupAgentStore;

    await expect(
      resolveOrgAgentConversationRouteHint({
        store,
        tenantId: 'tenant-a',
        agentId: 'agent-a',
        bindingId: 'binding-a',
        content: '继续 W-abcdef123456',
        actor: {
          kind: 'external_user',
          provider: 'dingtalk',
          corpId: 'corp-a',
          openId: 'user-a',
          assurance: 'mapped',
        },
      }),
    ).resolves.toEqual({ workOrder: work });
  });
});
