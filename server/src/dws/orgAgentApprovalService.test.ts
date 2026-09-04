import { describe, expect, it, vi } from 'vitest';

import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import type { RunRecord, RunStatus } from '../runtime/runStore.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';
import { snapshotOrgAgentRunContext } from '../runtime/orgAgentRunContext.js';
import type { ChannelContext } from '../types/index.js';
import { OrgAgentApprovalError, OrgAgentApprovalService } from './orgAgentApprovalService.js';

const TENANT = 'tenant-a';
const ACCOUNT = 'account-a';

class MemoryEvents implements EventStore {
  events: PlatformEvent[] = [];
  async append(event: PlatformEventInput): Promise<PlatformEvent> {
    const full = {
      ...event,
      id:
        'id' in event && typeof event.id === 'string'
          ? event.id
          : `event-${this.events.length + 1}`,
      timestamp: new Date().toISOString(),
    } as PlatformEvent;
    this.events.push(full);
    return full;
  }
  async list(tenantId: string, sessionId: string): Promise<PlatformEvent[]> {
    return tenantId === TENANT ? this.events.filter((event) => event.sessionId === sessionId) : [];
  }
}

function orgContext(): ChannelContext {
  return {
    channel: 'dingtalk',
    user: { id: 'requester-a', username: 'requester', role: 'admin', tenantId: TENANT },
    orgAgentChannel: {
      accountId: ACCOUNT,
      agentId: 'agent-a',
      bindingId: 'binding-a',
      conversationSpaceId: 'space-a',
      workConversationId: 'work-conversation-a',
      policyRevision: 4,
      agentPrincipal: {
        kind: 'org_agent',
        tenantId: TENANT,
        agentId: 'agent-a',
        accountId: ACCOUNT,
        workspaceId: 'workspace-a',
      },
      externalActorAssurance: 'mapped',
      allowedToolNames: ['DwsBusiness'],
      allowedSkillIds: [],
      allowedSourceIds: [],
      dwsResourceIds: ['doc:doc-a'],
      contextEnabled: false,
      taskVisibility: 'conversation',
      actorRole: 'org_admin',
      triggerRoles: ['org_admin'],
      approvalRoles: ['org_admin'],
      externalActor: {
        kind: 'external_user',
        provider: 'dingtalk',
        corpId: 'corp-a',
        openId: 'open-a',
        mappedUserId: 'requester-a',
        role: 'org_admin',
        assurance: 'mapped',
      },
      channelPrincipal: {
        provider: 'dingtalk',
        accountId: ACCOUNT,
        conversationId: 'group-a',
        kind: 'group',
      },
    },
  };
}

function createRig() {
  const events = new MemoryEvents();
  const now = new Date().toISOString();
  let run: RunRecord = {
    runId: 'run-a',
    sessionId: 'session-a',
    userId: `adws-${ACCOUNT}`,
    tenantId: TENANT,
    status: 'waiting_approval',
    channel: 'web',
    requestedAt: now,
    updatedAt: now,
    metadata: {
      transcriptPath: '/tmp/session-a.jsonl',
      ...snapshotOrgAgentRunContext(orgContext()),
    },
  };
  const binding = {
    bindingId: 'binding-a',
    tenantId: TENANT,
    accountId: ACCOUNT,
    agentId: 'agent-a',
    conversationId: 'group-a',
    channelKind: 'group' as const,
    activationState: 'active' as const,
    enabled: true,
    conversationSpaceId: 'space-a',
    serviceSessionId: 'session-a',
    workspaceId: 'workspace-a',
    policy: {
      enabled: true,
      membership: 'members' as const,
      guest: 'deny' as const,
      taskVisibility: 'conversation' as const,
      completion: 'reply_to_work_conversation' as const,
      liveDeny: false,
    },
    effectiveConfig: {
      identity: {},
      instructions: { system: '' },
      knowledge: { contextEnabled: false, sourceIds: [] },
      capabilities: { skillIds: [], toolNames: ['DwsBusiness'], dwsResourceIds: ['doc:doc-a'] },
      memory: { readAgent: false, readConversation: false, adminWriteConversation: false },
      access: { triggerRoles: ['org_admin' as const], approvalRoles: ['org_admin' as const] },
      speech: { proactive: false, requireMention: true },
    },
    revision: 4,
    createdAt: now,
    updatedAt: now,
  };
  const runStore = {
    get: vi.fn(async () => run),
    claimPersistedInteractionResume: vi.fn(
      async (
        _runId: string,
        statuses: readonly RunStatus[],
        _reason: string,
        metadataPatch: Record<string, unknown>,
      ) => {
        if (!statuses.includes(run.status)) return null;
        run = {
          ...run,
          status: 'pending',
          metadata: { ...run.metadata, ...metadataPatch, schedulerState: 'staged' },
        };
        return run;
      },
    ),
    rollbackPersistedInteractionResume: vi.fn(async () => {
      run = {
        ...run,
        status: 'waiting_approval',
        metadata: { ...run.metadata, schedulerState: undefined },
      };
      return run;
    }),
  };
  const scheduler = {
    activateCreatedRun: vi.fn(
      async (_runId: string, _claim?: Record<string, unknown>, patch?: Record<string, unknown>) => {
        run = { ...run, metadata: { ...run.metadata, ...patch, schedulerState: 'ready' } };
        return run;
      },
    ),
  };
  const service = new OrgAgentApprovalService({
    messageStore: {
      listActiveForAccount: vi.fn(async () => [
        {
          inboxId: 'inbox-a',
          tenantId: TENANT,
          accountId: ACCOUNT,
          eventId: 'event-a',
          eventType: 'user_im_message_receive_at',
          conversationId: 'group-a',
          content: '更新文档',
          senderOpenDingtalkId: 'open-a',
          payload: {},
          workConversationId: 'work-conversation-a',
          state: 'processing' as const,
          sessionId: 'session-a',
          runId: 'run-a',
          attempt: 1,
          maxAttempts: 3,
          leaseFence: 1,
          createdAt: now,
          updatedAt: now,
        },
      ]),
    },
    runStore,
    eventStoreFor: () => events,
    scheduler,
    orgGroupAgentStore: { getBindingById: vi.fn(async () => binding) },
    userStore: {
      findById: vi.fn(() => ({
        id: 'requester-a',
        username: 'requester',
        passwordHash: 'x',
        role: 'admin' as const,
        tenantId: TENANT,
        createdAt: now,
        createdBy: 'test',
        updatedAt: now,
      })),
    },
    resolveRequesterGovernanceRole: vi.fn(async () => 'org_admin' as const),
  });
  return { service, events, runStore, scheduler, binding, currentRun: () => run };
}

describe('OrgAgentApprovalService', () => {
  it('展示脱敏审批，并通过 CAS 事件和原 Run 恢复执行', async () => {
    const rig = createRig();
    const approval = await new EventBackedApprovalStore(rig.events, 'session-a', TENANT).create({
      sessionId: 'session-a',
      runId: 'run-a',
      toolCallId: 'call-a',
      toolId: 'dws-business',
      toolName: 'DwsBusiness',
      displayName: '更新钉钉文档',
      input: { args: ['doc', 'update', '--node', 'doc-a'], token: 'secret' },
    });

    await expect(rig.service.listPending(TENANT, ACCOUNT)).resolves.toMatchObject([
      { approvalId: approval.id, input: { token: '[REDACTED]' } },
    ]);
    await expect(
      rig.service.decide({
        tenantId: TENANT,
        accountId: ACCOUNT,
        approvalId: approval.id,
        decision: 'approved',
        actorUserId: 'admin-a',
      }),
    ).resolves.toEqual({
      approvalId: approval.id,
      runId: 'run-a',
      status: 'queued',
      changed: true,
    });
    expect(rig.runStore.claimPersistedInteractionResume).toHaveBeenCalledOnce();
    expect(rig.scheduler.activateCreatedRun).toHaveBeenCalledOnce();
    expect(rig.currentRun()).toMatchObject({
      status: 'pending',
      metadata: { schedulerState: 'ready' },
    });
    expect(rig.events.events).toContainEqual(
      expect.objectContaining({
        type: 'interaction_resolved',
        interactionId: approval.id,
        userId: 'admin-a',
        response: { allow: true, message: '组织管理员已批准' },
      }),
    );
  });

  it('绑定 revision 或 liveDeny 变化后拒绝旧审批', async () => {
    const rig = createRig();
    rig.binding.policy.liveDeny = true;
    const approval = await new EventBackedApprovalStore(rig.events, 'session-a', TENANT).create({
      sessionId: 'session-a',
      runId: 'run-a',
      toolCallId: 'call-a',
      toolId: 'dws-business',
      toolName: 'DwsBusiness',
      input: { args: ['doc', 'update', '--node', 'doc-a'] },
    });
    await expect(
      rig.service.decide({
        tenantId: TENANT,
        accountId: ACCOUNT,
        approvalId: approval.id,
        decision: 'approved',
        actorUserId: 'admin-a',
      }),
    ).rejects.toMatchObject({ status: 409 } satisfies Partial<OrgAgentApprovalError>);
    expect(rig.runStore.claimPersistedInteractionResume).not.toHaveBeenCalled();
  });

  it('并发相反决定返回冲突，同向重试保持幂等', async () => {
    const rig = createRig();
    const approval = await new EventBackedApprovalStore(rig.events, 'session-a', TENANT).create({
      sessionId: 'session-a',
      runId: 'run-a',
      toolCallId: 'call-a',
      toolId: 'dws-business',
      toolName: 'DwsBusiness',
      input: { args: ['doc', 'update', '--node', 'doc-a'] },
    });
    const request = {
      tenantId: TENANT,
      accountId: ACCOUNT,
      approvalId: approval.id,
      decision: 'approved' as const,
      actorUserId: 'admin-a',
    };
    await expect(rig.service.decide(request)).resolves.toMatchObject({
      status: 'queued',
      changed: true,
    });
    await expect(rig.service.decide(request)).resolves.toMatchObject({
      status: 'queued',
      changed: false,
    });
    await expect(rig.service.decide({ ...request, decision: 'rejected' })).rejects.toMatchObject({
      status: 409,
      changed: false,
    });
  });

  it('审批结果已持久化但调度暂未接管时返回 changed=true 的恢复中终态', async () => {
    const rig = createRig();
    rig.scheduler.activateCreatedRun.mockResolvedValueOnce(null as never);
    const approval = await new EventBackedApprovalStore(rig.events, 'session-a', TENANT).create({
      sessionId: 'session-a',
      runId: 'run-a',
      toolCallId: 'call-a',
      toolId: 'dws-business',
      toolName: 'DwsBusiness',
      input: { args: ['doc', 'update', '--node', 'doc-a'] },
    });
    await expect(
      rig.service.decide({
        tenantId: TENANT,
        accountId: ACCOUNT,
        approvalId: approval.id,
        decision: 'approved',
        actorUserId: 'admin-a',
      }),
    ).resolves.toMatchObject({ status: 'recovery_pending', changed: true });
  });
});
