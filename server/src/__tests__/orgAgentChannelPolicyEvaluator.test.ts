import { describe, expect, it, vi } from 'vitest';

import { createOrgAgentChannelPolicyEvaluator } from '../app/orgAgentChannelPolicyEvaluator.js';

const input = {
  tenantId: 'tenant-1',
  bindingId: 'binding-1',
  accountId: 'account-1',
  agentId: 'agent-1',
  conversationId: 'group-1',
  toolName: 'WriteTool',
};

function binding(overrides: Record<string, unknown> = {}) {
  return {
    bindingId: 'binding-1',
    accountId: 'account-1',
    agentId: 'agent-1',
    conversationId: 'group-1',
    enabled: true,
    policy: { enabled: true, liveDeny: false },
    effectiveConfig: { capabilities: { toolNames: ['WriteTool'] } },
    ...overrides,
  };
}

describe('organization Agent live channel policy', () => {
  it('allows only an intact account, Agent and binding principal chain', async () => {
    const evaluate = createOrgAgentChannelPolicyEvaluator(
      { getBindingById: vi.fn(async () => binding()) } as never,
      {
        getForTenant: vi.fn(async () => ({
          accountId: 'account-1',
          agentId: 'agent-1',
          status: 'active',
        })),
      } as never,
      { get: vi.fn(() => ({ agentId: 'agent-1', tenantId: 'tenant-1', enabled: true })) } as never,
    );
    await expect(evaluate(input)).resolves.toEqual({
      allowed: true,
      reason: 'tool is outside current ChannelBinding capability',
    });
  });

  it('denies a stale account-to-Agent association even if the binding still allows the tool', async () => {
    const evaluate = createOrgAgentChannelPolicyEvaluator(
      { getBindingById: vi.fn(async () => binding()) } as never,
      {
        getForTenant: vi.fn(async () => ({
          accountId: 'account-1',
          agentId: 'agent-2',
          status: 'active',
        })),
      } as never,
      { get: vi.fn(() => ({ agentId: 'agent-1', tenantId: 'tenant-1', enabled: true })) } as never,
    );
    await expect(evaluate(input)).resolves.toEqual({
      allowed: false,
      reason: 'ChannelBinding principal chain is stale or mismatched',
    });
  });
});
