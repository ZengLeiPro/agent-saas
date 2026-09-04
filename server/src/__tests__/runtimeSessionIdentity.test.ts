import { describe, expect, it } from 'vitest';

import { runtimePrincipalMatches } from '../runtime/runtimeSessionIdentity.js';

describe('runtimePrincipalMatches', () => {
  it('fails closed when an existing pinned principal is omitted by the request', () => {
    expect(runtimePrincipalMatches({ kind: 'user', userId: 'user-1' }, undefined)).toBe(false);
  });

  it('accepts a legacy user session only when its durable owner matches', () => {
    expect(
      runtimePrincipalMatches(
        undefined,
        { kind: 'user', userId: 'user-1' },
        {
          userId: 'user-1',
          tenantId: 'tenant-1',
          orgAgentId: undefined,
          workspaceId: 'workspace-1',
        },
      ),
    ).toBe(true);
    expect(
      runtimePrincipalMatches(
        undefined,
        { kind: 'user', userId: 'user-2' },
        {
          userId: 'user-1',
          tenantId: 'tenant-1',
          orgAgentId: undefined,
          workspaceId: 'workspace-1',
        },
      ),
    ).toBe(false);
  });

  it('accepts a legacy organization Agent session only on the full tenant/Agent/workspace tuple', () => {
    const principal = {
      kind: 'org_agent' as const,
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      accountId: 'account-1',
      workspaceId: 'workspace-1',
    };
    expect(
      runtimePrincipalMatches(undefined, principal, {
        userId: 'service-user',
        tenantId: 'tenant-1',
        orgAgentId: 'agent-1',
        workspaceId: 'workspace-1',
      }),
    ).toBe(true);
    expect(
      runtimePrincipalMatches(undefined, principal, {
        userId: 'service-user',
        tenantId: 'tenant-1',
        orgAgentId: 'agent-2',
        workspaceId: 'workspace-1',
      }),
    ).toBe(false);
  });
});
