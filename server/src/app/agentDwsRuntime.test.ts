import { describe, expect, it, vi } from 'vitest';

import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import type { OrgAgentRecord } from '../data/orgAgents/types.js';
import { InMemoryGovernanceAuditStore } from '../data/governance-audit/store.js';
import { authorizeAgentDwsRequesterAccess } from './agentDwsRuntime.js';

const account = {
  accountId: 'account-a', tenantId: 'tenant-a', agentId: 'agent-a', displayName: '专家甲',
} as AgentDwsAccountRecord;
const requester = {
  id: 'user-a', username: 'alice', role: 'user' as const, tenantId: 'tenant-a',
};
const agent = {
  id: 'agent-a', tenantId: 'tenant-a', enabled: true,
  audience: { exposure: 'allow_users', usernames: ['alice'] },
} as OrgAgentRecord;

function setup(input: { agent?: OrgAgentRecord; verdict?: 'allow' | 'deny' } = {}) {
  const preflight = vi.fn().mockResolvedValue({
    accessDecision: {
      verdict: input.verdict ?? 'allow',
      reasonCode: input.verdict === 'deny' ? 'ASSIGNMENT_SUBJECT_NOT_ASSIGNED' : 'ACCESS_ALLOWED',
    },
  });
  return {
    orgAgentStore: { get: vi.fn().mockReturnValue(input.agent ?? agent) },
    runPreflightService: { preflight },
    auditStore: new InMemoryGovernanceAuditStore(),
    preflight,
  };
}

describe('authorizeAgentDwsRequesterAccess', () => {
  it('audience 通过后以真实 requester 执行 Assignment preflight', async () => {
    const deps = setup();
    await expect(authorizeAgentDwsRequesterAccess({
      account, requester, sessionId: 'session-a', runId: 'run-a', ...deps,
    })).resolves.toEqual({ allowed: true });
    expect(deps.preflight).toHaveBeenCalledWith({
      phase: 'enqueue', runId: 'run-a', sessionId: 'session-a', userId: 'user-a',
      tenantId: 'tenant-a', orgAgentId: 'agent-a', skipBilling: true,
    });
  });

  it('audience 拒绝时不进入治理 preflight', async () => {
    const deps = setup({ agent: {
      ...agent,
      audience: { exposure: 'allow_users', usernames: ['bob'] },
    } });
    await expect(authorizeAgentDwsRequesterAccess({
      account, requester, sessionId: 'session-a', runId: 'run-a', ...deps,
    })).resolves.toEqual({ allowed: false, reason: 'ORG_AGENT_AUDIENCE_DENIED' });
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.auditStore.events).toEqual([
      expect.objectContaining({ action: 'dws.requester.access_decision', result: 'failed', reason: 'ORG_AGENT_AUDIENCE_DENIED' }),
    ]);
  });

  it('Assignment deny 即使处于 shadow 模式也按 accessDecision 硬拒绝', async () => {
    const deps = setup({ verdict: 'deny' });
    await expect(authorizeAgentDwsRequesterAccess({
      account, requester, sessionId: 'session-a', runId: 'run-a', ...deps,
    })).resolves.toEqual({ allowed: false, reason: 'ASSIGNMENT_SUBJECT_NOT_ASSIGNED' });
  });
});
