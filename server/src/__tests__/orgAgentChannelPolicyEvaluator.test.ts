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
    activationState: 'active',
    policy: { enabled: true, liveDeny: false },
    effectiveConfig: { capabilities: { toolNames: ['WriteTool'] } },
    accountIdentity: {
      profileId: 'corp-1:user-1',
      corpId: 'corp-1',
      dingtalkUserId: 'user-1',
      identityUpdatedAt: '2026-09-05T00:00:00.000Z',
    },
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
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          status: 'active',
          corpId: 'corp-1',
          dingtalkUserId: 'user-1',
          profileId: 'corp-1:user-1',
          identityUpdatedAt: '2026-09-05T00:00:00.000Z',
        })),
      } as never,
      { get: vi.fn(() => ({ agentId: 'agent-1', tenantId: 'tenant-1', enabled: true })) } as never,
    );
    await expect(evaluate(input)).resolves.toEqual({ allowed: true });
  });

  it('keeps the attempt capability snapshot stable across non-deny binding edits', async () => {
    const evaluate = createOrgAgentChannelPolicyEvaluator(
      {
        getBindingById: vi.fn(async () => binding({
          effectiveConfig: { capabilities: { toolNames: [] } },
        })),
      } as never,
      {
        getForTenant: vi.fn(async () => ({
          accountId: 'account-1', tenantId: 'tenant-1', agentId: 'agent-1', status: 'active',
          corpId: 'corp-1', dingtalkUserId: 'user-1', profileId: 'corp-1:user-1',
          identityUpdatedAt: '2026-09-05T00:00:00.000Z',
        })),
      } as never,
      { get: vi.fn(() => ({ agentId: 'agent-1', tenantId: 'tenant-1', enabled: true })) } as never,
    );
    await expect(evaluate(input)).resolves.toEqual({ allowed: true });
  });

  it('denies a stale account-to-Agent association even if the binding still allows the tool', async () => {
    const evaluate = createOrgAgentChannelPolicyEvaluator(
      { getBindingById: vi.fn(async () => binding()) } as never,
      {
        getForTenant: vi.fn(async () => ({
          accountId: 'account-1',
          tenantId: 'tenant-1',
          agentId: 'agent-2',
          status: 'active',
          corpId: 'corp-1',
          dingtalkUserId: 'user-1',
          profileId: 'corp-1:user-1',
          identityUpdatedAt: '2026-09-05T00:00:00.000Z',
        })),
      } as never,
      { get: vi.fn(() => ({ agentId: 'agent-1', tenantId: 'tenant-1', enabled: true })) } as never,
    );
    await expect(evaluate(input)).resolves.toEqual({
      allowed: false,
      reason: 'ChannelBinding principal chain is stale or mismatched',
    });
  });

  it('denies an existing Run after the account is rebound to another DingTalk identity', async () => {
    const evaluate = createOrgAgentChannelPolicyEvaluator(
      { getBindingById: vi.fn(async () => binding()) } as never,
      {
        getForTenant: vi.fn(async () => ({
          accountId: 'account-1', tenantId: 'tenant-1', agentId: 'agent-1', status: 'active',
          corpId: 'corp-1', dingtalkUserId: 'user-2', profileId: 'corp-1:user-2',
          identityUpdatedAt: '2026-09-05T01:00:00.000Z',
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
