import { redactInteractionCredentials } from '@agent/shared';

import type { AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import type { OrgAgentChannelBinding, OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import type { UserStore } from '../data/users/store.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import type { ApprovalRecord } from '../runtime/approvalTypes.js';
import type { RunRecord, RunStore } from '../runtime/runStore.js';
import type { EventStore, PlatformEvent } from '../runtime/types.js';
import {
  appendPersistedInteractionResolved,
  claimPersistedInteractionResume,
  claimsMatch,
  isPersistedInteractionClaim,
  isPersistedInteractionClaimExpired,
  persistedInteractionEventId,
} from '../channels/web/channelRuntimeHelpers.js';
import { restoreOrgAgentRunContext } from '../runtime/orgAgentRunContext.js';

export interface OrgAgentPendingApprovalView {
  approvalId: string;
  inboxId: string;
  sessionId: string;
  runId: string;
  bindingId: string;
  conversationId: string;
  workConversationId: string;
  toolName: string;
  displayName?: string;
  input: unknown;
  createdAt: string;
}

export class OrgAgentApprovalError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    message: string,
    readonly changed = false,
  ) {
    super(message);
  }
}

type ApprovalRunStore = Pick<
  RunStore,
  'get' | 'claimPersistedInteractionResume' | 'rollbackPersistedInteractionResume'
>;

export class OrgAgentApprovalService {
  constructor(
    private readonly deps: {
      messageStore: Pick<AgentDwsMessageStore, 'listActiveForAccount'>;
      runStore: ApprovalRunStore;
      eventStoreFor(transcriptPath: string, tenantId: string): EventStore;
      scheduler: {
        activateCreatedRun(
          runId: string,
          interactionClaim?: Record<string, unknown>,
          interactionMetadataPatch?: Record<string, unknown>,
        ): Promise<RunRecord | null>;
      };
      orgGroupAgentStore: Pick<OrgGroupAgentStore, 'getBindingById'>;
      userStore: Pick<UserStore, 'findById'>;
      resolveRequesterGovernanceRole(
        tenantId: string,
        userId: string,
      ): Promise<'member' | 'org_admin' | undefined>;
    },
  ) {}

  async listPending(
    tenantId: string,
    accountId: string,
    limit = 100,
  ): Promise<OrgAgentPendingApprovalView[]> {
    const inboxes = await this.deps.messageStore.listActiveForAccount(tenantId, accountId);
    const results = await Promise.all(
      inboxes.map(async (inbox) => {
        if (!inbox.sessionId || !inbox.runId || !inbox.workConversationId) return [];
        const run = await this.deps.runStore.get(inbox.runId);
        const context = run ? this.validateRunContext({ tenantId, accountId, inbox, run }) : null;
        if (!run || !context || !['waiting_approval', 'pending'].includes(run.status)) return [];
        const binding = await this.deps.orgGroupAgentStore.getBindingById(
          tenantId,
          context.bindingId,
        );
        try {
          await this.assertLiveBinding({ tenantId, accountId }, binding, run);
        } catch {
          return [];
        }
        const eventStore = this.eventStore(run, tenantId);
        const approvals = await new EventBackedApprovalStore(
          eventStore,
          run.sessionId,
          tenantId,
        ).listPending(run.sessionId);
        return approvals
          .filter((approval) => approval.runId === run.runId && approval.toolName === 'DwsBusiness')
          .map((approval) => this.toView(inbox.inboxId, context, approval));
      }),
    );
    const unique = new Map<string, OrgAgentPendingApprovalView>();
    for (const approval of results.flat()) unique.set(approval.approvalId, approval);
    return [...unique.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(100, Math.trunc(limit))));
  }

  async decide(input: {
    tenantId: string;
    accountId: string;
    approvalId: string;
    decision: 'approved' | 'rejected';
    actorUserId: string;
    message?: string;
  }): Promise<{
    approvalId: string;
    runId: string;
    status: 'queued' | 'recovery_pending';
    changed: boolean;
  }> {
    const located = await this.locate(input.tenantId, input.accountId, input.approvalId);
    if (!located) throw new OrgAgentApprovalError(404, '待审批操作不存在或已失效');
    const { approval, run, eventStore, binding } = located;
    await this.assertLiveBinding(input, binding, run);
    const response = {
      allow: input.decision === 'approved',
      message:
        input.message ?? (input.decision === 'approved' ? '组织管理员已批准' : '组织管理员已拒绝'),
    };
    const eventId = persistedInteractionEventId(run.sessionId, approval.id);
    let current = await this.deps.runStore.get(run.runId);
    let canonical = await this.findCanonical(eventStore, input.tenantId, run.sessionId, eventId);
    if (current?.status === 'pending' && current.metadata.schedulerState === 'ready') {
      this.assertSameDecision(canonical, input.decision);
      return { approvalId: approval.id, runId: run.runId, status: 'queued', changed: false };
    }
    const stagedClaim = current?.metadata.persistedInteractionResumeClaim;
    if (
      current?.status === 'pending' &&
      isPersistedInteractionClaim(stagedClaim, run.sessionId, approval.id)
    ) {
      if (canonical) {
        this.assertSameDecision(canonical, input.decision);
        const activated = await this.deps.scheduler.activateCreatedRun(run.runId, stagedClaim, {
          resumeApproval: { approvalId: approval.id, response: canonical.response },
        });
        return {
          approvalId: approval.id,
          runId: run.runId,
          status: activated ? 'queued' : 'recovery_pending',
          changed: Boolean(activated),
        };
      }
      if (!isPersistedInteractionClaimExpired(stagedClaim)) {
        throw new OrgAgentApprovalError(409, '审批恢复正由其他进程处理');
      }
      const rollback = this.deps.runStore.rollbackPersistedInteractionResume;
      if (
        !rollback ||
        !(await rollback.call(
          this.deps.runStore,
          run.runId,
          stagedClaim,
          'waiting_approval',
          'org_agent_approval_recovery',
        ))
      )
        throw new OrgAgentApprovalError(409, '审批恢复状态正在变化，请重试');
      current = await this.deps.runStore.get(run.runId);
    }
    if (canonical) {
      this.assertSameDecision(canonical, input.decision);
      return {
        approvalId: approval.id,
        runId: run.runId,
        status: 'recovery_pending',
        changed: false,
      };
    }
    if (current?.status !== 'waiting_approval') {
      throw new OrgAgentApprovalError(409, '原任务已不处于待审批状态');
    }
    const claim = await claimPersistedInteractionResume({
      runStore: this.requireClaimStore(),
      runId: run.runId,
      expectedStatus: 'waiting_approval',
      reason: 'org_agent_approval_resolved_enqueue_resume',
      sessionId: run.sessionId,
      interactionId: approval.id,
      interactionType: 'approval',
      response,
      transcriptPath: this.transcriptPath(run),
    });
    if (claim.outcome !== 'claimed') {
      throw new OrgAgentApprovalError(409, '审批恢复正由其他进程处理');
    }
    const claimedRun = await this.deps.runStore.get(run.runId);
    if (
      !claimsMatch(
        claimedRun?.metadata.persistedInteractionResumeClaim,
        claim.metadata.persistedInteractionResumeClaim,
      )
    )
      throw new OrgAgentApprovalError(409, '审批恢复所有权已变化');
    try {
      canonical = await appendPersistedInteractionResolved(eventStore, input.tenantId, {
        id: eventId,
        type: 'interaction_resolved',
        sessionId: run.sessionId,
        runId: run.runId,
        interactionId: approval.id,
        interactionType: 'approval',
        userId: input.actorUserId,
        response,
      });
    } catch (error) {
      await this.deps.runStore.rollbackPersistedInteractionResume?.(
        run.runId,
        claim.metadata.persistedInteractionResumeClaim,
        'waiting_approval',
        'org_agent_approval_event_append_failed',
      );
      throw error;
    }
    const activated = await this.deps.scheduler.activateCreatedRun(
      run.runId,
      claim.metadata.persistedInteractionResumeClaim,
      { resumeApproval: { approvalId: approval.id, response: canonical.response } },
    );
    return {
      approvalId: approval.id,
      runId: run.runId,
      status: activated ? 'queued' : 'recovery_pending',
      changed: true,
    };
  }

  private async locate(tenantId: string, accountId: string, approvalId: string) {
    const inboxes = await this.deps.messageStore.listActiveForAccount(tenantId, accountId);
    for (const inbox of inboxes) {
      if (!inbox.sessionId || !inbox.runId || !inbox.workConversationId) continue;
      const run = await this.deps.runStore.get(inbox.runId);
      const context = run ? this.validateRunContext({ tenantId, accountId, inbox, run }) : null;
      if (!run || !context) continue;
      const eventStore = this.eventStore(run, tenantId);
      const approval = await new EventBackedApprovalStore(eventStore, run.sessionId, tenantId).get(
        approvalId,
      );
      if (
        approval?.status !== 'pending' ||
        approval.runId !== run.runId ||
        approval.toolName !== 'DwsBusiness'
      )
        continue;
      const binding = await this.deps.orgGroupAgentStore.getBindingById(
        tenantId,
        context.bindingId,
      );
      return { inbox, run, context, eventStore, approval, binding };
    }
    return null;
  }

  private validateRunContext(input: {
    tenantId: string;
    accountId: string;
    inbox: {
      tenantId: string;
      accountId: string;
      sessionId?: string;
      runId?: string;
      conversationId: string;
      workConversationId?: string;
      senderOpenDingtalkId?: string;
    };
    run: RunRecord;
  }) {
    const context = restoreOrgAgentRunContext(input.run.metadata);
    const channel = context.orgAgentChannel;
    const actor = channel?.externalActor;
    if (
      !channel ||
      !context.user ||
      actor?.kind !== 'external_user' ||
      actor.assurance !== 'mapped' ||
      input.inbox.tenantId !== input.tenantId ||
      input.inbox.accountId !== input.accountId ||
      input.run.runId !== input.inbox.runId ||
      input.run.tenantId !== input.tenantId ||
      input.run.sessionId !== input.inbox.sessionId ||
      channel.agentPrincipal.tenantId !== input.tenantId ||
      channel.accountId !== input.accountId ||
      channel.channelPrincipal.accountId !== input.accountId ||
      channel.channelPrincipal.conversationId !== input.inbox.conversationId ||
      channel.workConversationId !== input.inbox.workConversationId ||
      actor.openId !== input.inbox.senderOpenDingtalkId ||
      context.user.id !== actor.mappedUserId
    )
      return null;
    return channel;
  }

  private async assertLiveBinding(
    input: { tenantId: string; accountId: string },
    binding: OrgAgentChannelBinding | null,
    run: RunRecord,
  ): Promise<void> {
    const channel = restoreOrgAgentRunContext(run.metadata).orgAgentChannel;
    const actor = channel?.externalActor;
    const requester = restoreOrgAgentRunContext(run.metadata).user;
    const currentUser = requester ? this.deps.userStore.findById(requester.id) : undefined;
    const currentRole = requester
      ? await this.deps.resolveRequesterGovernanceRole(input.tenantId, requester.id)
      : undefined;
    if (
      !channel ||
      actor?.kind !== 'external_user' ||
      actor.assurance !== 'mapped' ||
      !requester ||
      !currentUser ||
      currentUser.disabled ||
      currentUser.tenantId !== input.tenantId ||
      currentUser.username !== requester.username ||
      currentRole !== actor.role ||
      !currentRole ||
      !binding ||
      binding.tenantId !== input.tenantId ||
      binding.accountId !== input.accountId ||
      binding.bindingId !== channel.bindingId ||
      binding.agentId !== channel.agentId ||
      binding.conversationId !== channel.channelPrincipal.conversationId ||
      binding.conversationSpaceId !== channel.conversationSpaceId ||
      binding.workspaceId !== channel.agentPrincipal.workspaceId ||
      binding.revision !== channel.policyRevision ||
      !binding.enabled ||
      binding.activationState !== 'active' ||
      !binding.policy.enabled ||
      binding.policy.liveDeny ||
      !binding.effectiveConfig.capabilities.toolNames.includes('DwsBusiness') ||
      !binding.effectiveConfig.access.approvalRoles.includes('org_admin')
    ) {
      throw new OrgAgentApprovalError(409, '群绑定或权限已变化，请在群内重新发起操作');
    }
  }

  private toView(
    inboxId: string,
    context: NonNullable<ReturnType<OrgAgentApprovalService['validateRunContext']>>,
    approval: ApprovalRecord,
  ): OrgAgentPendingApprovalView {
    return {
      approvalId: approval.id,
      inboxId,
      sessionId: approval.sessionId,
      runId: approval.runId,
      bindingId: context.bindingId,
      conversationId: context.channelPrincipal.conversationId,
      workConversationId: context.workConversationId,
      toolName: approval.toolName,
      ...(approval.displayName ? { displayName: approval.displayName } : {}),
      input: redactInteractionCredentials(approval.input),
      createdAt: approval.createdAt,
    };
  }

  private eventStore(run: RunRecord, tenantId: string): EventStore {
    return this.deps.eventStoreFor(this.transcriptPath(run), tenantId);
  }

  private transcriptPath(run: RunRecord): string {
    return typeof run.metadata.transcriptPath === 'string' ? run.metadata.transcriptPath : '';
  }

  private requireClaimStore(): Pick<RunStore, 'claimPersistedInteractionResume'> {
    if (!this.deps.runStore.claimPersistedInteractionResume) {
      throw new OrgAgentApprovalError(503, '运行时暂不支持持久化审批恢复');
    }
    return this.deps.runStore;
  }

  private async findCanonical(
    eventStore: EventStore,
    tenantId: string,
    sessionId: string,
    eventId: string,
  ): Promise<Extract<PlatformEvent, { type: 'interaction_resolved' }> | undefined> {
    return (await eventStore.list(tenantId, sessionId)).find(
      (event): event is Extract<PlatformEvent, { type: 'interaction_resolved' }> =>
        event.type === 'interaction_resolved' && event.id === eventId,
    );
  }

  private assertSameDecision(
    canonical: Extract<PlatformEvent, { type: 'interaction_resolved' }> | undefined,
    decision: 'approved' | 'rejected',
  ): void {
    const expected = decision === 'approved';
    const response = canonical?.response;
    if (
      !response ||
      typeof response !== 'object' ||
      Array.isArray(response) ||
      typeof (response as Record<string, unknown>).allow !== 'boolean'
    ) {
      throw new OrgAgentApprovalError(409, '审批恢复状态不完整，请稍后重试');
    }
    if ((response as Record<string, unknown>).allow !== expected) {
      throw new OrgAgentApprovalError(409, '该审批已由相反决定处理');
    }
  }
}
