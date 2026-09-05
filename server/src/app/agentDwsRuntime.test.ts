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

describe('authorizeAgentDwsRequesterAccess provider fence', () => {
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

  it('provider-start 最终授权在慢审计后重新读取 audience/Assignment', async () => {
    let releaseAudit!: () => void;
    let auditStarted!: () => void;
    const started = new Promise<void>(resolve => { auditStarted = resolve; });
    const auditStore = { append: vi.fn().mockImplementationOnce(async () => {
      auditStarted();
      await new Promise<void>(resolve => { releaseAudit = resolve; });
    }).mockResolvedValue(undefined) };
    const deps = setup();
    const pending = authorizeAgentDwsRequesterAccess({
      account, requester, sessionId: 'session-a', runId: 'run-a', phase: 'provider_start',
      ...deps, auditStore: auditStore as never,
    });
    await started;
    deps.orgAgentStore.get.mockReturnValue({ ...agent, enabled: false });
    releaseAudit();

    await expect(pending).resolves.toEqual({ allowed: false, reason: 'ORG_AGENT_UNAVAILABLE' });
    expect(deps.preflight).toHaveBeenCalledOnce();
    expect(auditStore.append).toHaveBeenCalledTimes(2);
  });

  it('Assignment deny 即使处于 shadow 模式也按 accessDecision 硬拒绝', async () => {
    const deps = setup({ verdict: 'deny' });
    await expect(authorizeAgentDwsRequesterAccess({
      account, requester, sessionId: 'session-a', runId: 'run-a', ...deps,
    })).resolves.toEqual({ allowed: false, reason: 'ASSIGNMENT_SUBJECT_NOT_ASSIGNED' });
  });
});
