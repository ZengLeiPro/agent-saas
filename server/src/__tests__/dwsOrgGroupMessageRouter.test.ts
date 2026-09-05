import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AgentRunDispatch } from '../agent/index.js';
import { AgentDwsMessageRouter } from '../dws/personalMessageRouter.js';
import {
  account,
  deferred,
  delivery,
  item,
  now,
  setup,
  workOrder,
} from './dwsOrgGroupMessageRouterFixtures.js';

describe('AgentDwsMessageRouter organization group discovery/binding', () => {
  it('uses an Agent-owned WorkConversation and durable delivery', async () => {
    const test = setup();
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.messageStore.getOrCreateBinding).not.toHaveBeenCalled();
    expect(test.orgStore.pinInboxContext).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxId: 'inbox-a',
        conversationSpaceId: 'space-a',
        workConversationId: 'workconv-a',
      }),
    );
    expect(test.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        resumeSessionId: 'session-a',
        sessionOwner: expect.objectContaining({ username: 'agent-dws:agent-a' }),
        orgAgentChannel: expect.objectContaining({
          bindingId: 'channel-binding-a',
          actorRole: 'member',
          approvalRoles: ['org_admin'],
          externalActor: expect.objectContaining({ role: 'member' }),
        }),
      }),
      expect.objectContaining({ allowedTools: ['Agent', 'BackgroundTask'], skipMemory: true }),
      expect.any(Object),
    );
    expect(test.orgStore.createDelivery).toHaveBeenCalledOnce();
    const legacyProviderKey = `agent-dws-reply-${createHash('sha256')
      .update('account-a:event-a')
      .digest('hex')
      .slice(0, 32)}`;
    expect(test.orgStore.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: legacyProviderKey }),
    );
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      '完成',
      legacyProviderKey,
      expect.any(Function),
    );
    expect(test.orgStore.markDeliveryProviderStarted).toHaveBeenCalledOnce();
    expect(test.orgStore.markDeliverySent).toHaveBeenCalledOnce();
  });

  it('首条群 @ 只记录观测，不自动创建 shadow binding，并返回可见配置提示', async () => {
    const test = setup();
    vi.mocked(test.orgStore.getBinding).mockResolvedValue(null);
    await expect(test.router.ingest(account, {
      type: 'user_im_message_receive_at', eventId: 'event-a', conversationId: 'group-a',
      messageId: 'mid-a', senderOpenDingtalkId: 'requester-open-id', senderName: '成员甲',
      content: '@开开 请处理', raw: {},
    })).resolves.toBe(true);
    await vi.waitFor(() => expect(test.messageStore.reject).toHaveBeenCalled());
    expect(test.orgStore.ensureShadowBinding).not.toHaveBeenCalled();
    expect(test.orgStore.pinInboxContext).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.messageStore.reject).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, 'ORG_AGENT_CHANNEL_UNCONFIGURED');
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object), expect.any(Object), expect.stringContaining('群尚未配置'),
      expect.any(String), expect.any(Function));
    await test.router.stop();
  });

  it('routes an obvious continuation when its native thread has exactly one visible task', async () => {
    const routed = workOrder({ shortId: 'W-123456ABCDEF' });
    const test = setup({
      claimed: { ...item, content: '继续这个任务', workConversationId: 'workconv-route-a' },
      workOrders: [routed],
    });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.orgStore.pinInboxContext).toHaveBeenCalledWith(
      expect.objectContaining({
        workConversationId: 'workconv-route-a',
      }),
    );
    expect(test.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ resumeSessionId: 'session-routed' }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('asks for a task reference instead of guessing from one binding-level candidate', async () => {
    const routed = workOrder({ shortId: 'W-123456ABCDEF' });
    const test = setup({ content: '继续这个任务', workOrders: [routed] });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.stringContaining('W-123456ABCDEF'),
      expect.any(String),
      expect.any(Function),
    );
  });

  it('keeps two active WorkOrders in one native thread ambiguous instead of choosing the latest', async () => {
    const first = workOrder({ shortId: 'W-123456ABCDEF', title: '采购异常核对' });
    const second = workOrder({
      workOrderId: 'work-route-b',
      shortId: 'W-987654ABCDEF',
      title: '采购合同复核',
    });
    const test = setup({
      claimed: { ...item, content: '复核这个任务', workConversationId: 'workconv-route-a' },
      workOrders: [first, second],
    });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.messageStore.saveDispatchResult).toHaveBeenCalledWith(
      'inbox-a',
      expect.stringMatching(/^agent-dws-router:/),
      1,
      expect.stringContaining('W-123456ABCDEF'),
    );
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.stringContaining('W-987654ABCDEF'),
      expect.any(String),
      expect.any(Function),
    );
  });

  it('persists and sends one clarification instead of dispatching an ambiguous continuation', async () => {
    const first = workOrder({ shortId: 'W-123456ABCDEF', title: '采购异常核对' });
    const second = workOrder({
      workOrderId: 'work-route-b',
      shortId: 'W-987654ABCDEF',
      workConversationId: 'workconv-route-b',
      title: '供应商资料补全',
    });
    const test = setup({ content: '继续这个任务', workOrders: [first, second] });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.messageStore.saveDispatchResult).toHaveBeenCalledWith(
      'inbox-a',
      expect.stringMatching(/^agent-dws-router:/),
      1,
      expect.stringContaining('W-123456ABCDEF'),
    );
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.stringContaining('W-987654ABCDEF'),
      expect.any(String),
      expect.any(Function),
    );
    expect(test.messageStore.complete).toHaveBeenCalledOnce();
  });

  it('创建 delivery 后崩溃并撤权时，取消旧正文并恢复安全拒绝', async () => {
    const pendingReply = {
      ...item,
      state: 'reply_pending' as const,
      replyKind: 'normal' as const,
      responseText: '旧授权上下文生成的正文',
      replyStartedAt: now,
      attempt: 2,
      leaseFence: 2,
    };
    const test = setup({
      failFirstDeliveryClaim: true,
      claimedSequence: [item, pendingReply],
      authorizationSequence: [
        { allowed: true },
        { allowed: false, reason: 'ASSIGNMENT_DENIED' },
      ],
    });

    await expect(test.router.runOnce()).resolves.toBe(false);
    expect(test.orgStore.createDelivery).toHaveBeenCalledOnce();
    expect(test.sender.send).not.toHaveBeenCalled();

    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.orgStore.cancelUnstartedDeliveriesForInbox).toHaveBeenCalledWith(
      'tenant-a',
      'inbox-a',
      'ORG_AGENT_DIRECT_DELIVERY_AUTHORIZATION_REVOKED:ASSIGNMENT_DENIED',
    );
    expect(test.messageStore.blockReply).not.toHaveBeenCalled();
    expect(test.messageStore.saveRejectionResult).toHaveBeenCalledWith(
      'inbox-a', expect.stringMatching(/^agent-dws-router:/), 2,
      '当前请求未通过组织权限检查。请联系管理员确认本群配置和你的访问范围。',
      'ASSIGNMENT_DENIED', true,
    );
    expect(test.sender.send).toHaveBeenCalledWith(
      account, expect.any(Object),
      '当前请求未通过组织权限检查。请联系管理员确认本群配置和你的访问范围。',
      expect.any(String), expect.any(Function),
    );
    expect(await test.orgStore.getDelivery('tenant-a', 'delivery-a')).toMatchObject({
      deliveryState: 'dead_letter',
      lastError: 'ORG_AGENT_DIRECT_DELIVERY_AUTHORIZATION_REVOKED:ASSIGNMENT_DENIED',
    });
    await expect(test.router.runOnce()).resolves.toBe(false);
    expect(test.sender.send).toHaveBeenCalledOnce();
  });

  it('routing clarification 在 provider 前失败后可从 reply_pending 重领发送', async () => {
    const first = workOrder({ shortId: 'W-123456ABCDEF', title: '采购异常核对' });
    const second = workOrder({
      workOrderId: 'work-route-b', shortId: 'W-987654ABCDEF',
      workConversationId: 'workconv-route-b', title: '供应商资料补全',
    });
    const persisted = '首次生成后已持久化的 routing clarification';
    const test = setup({
      workOrders: [first, second],
      failFirstDeliveryClaim: true,
      claimedSequence: [
        { ...item, content: '继续这个任务' },
        {
          ...item, content: '继续这个任务', state: 'reply_pending', replyKind: 'normal',
          responseText: persisted, replyStartedAt: now, attempt: 2, leaseFence: 2,
        },
      ],
    });

    await expect(test.router.runOnce()).resolves.toBe(false);
    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.messageStore.saveDispatchResult).toHaveBeenCalledOnce();
    expect(test.messageStore.fail).toHaveBeenCalledOnce();
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object), expect.any(Object), expect.stringContaining('W-987654ABCDEF'),
      expect.any(String), expect.any(Function),
    );
    expect(test.messageStore.complete).toHaveBeenLastCalledWith(
      'inbox-a', expect.stringMatching(/^agent-dws-router:/), 2,
    );
  });

  it('routing clarification 重领时复用持久化正文且不重复保存', async () => {
    const first = workOrder({ shortId: 'W-123456ABCDEF', title: '采购异常核对' });
    const second = workOrder({
      workOrderId: 'work-route-b',
      shortId: 'W-987654ABCDEF',
      workConversationId: 'workconv-route-b',
      title: '供应商资料补全',
    });
    const test = setup({
      claimed: {
        ...item,
        content: '继续这个任务',
        state: 'reply_pending',
        replyKind: 'normal',
        responseText: '已持久化澄清正文',
        replyStartedAt: now,
      },
      workOrders: [first, second],
    });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.messageStore.saveDispatchResult).not.toHaveBeenCalled();
    expect(test.messageStore.markReplyAttemptStarted).toHaveBeenCalledOnce();
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      '已持久化澄清正文',
      expect.any(String),
      expect.any(Function),
    );
    expect(test.messageStore.complete).toHaveBeenCalledOnce();
  });

  it('does not route a private W-short number owned by another requester', async () => {
    const privateWork = workOrder({
      visibility: 'requester_only',
      createdByActor: {
        kind: 'external_user',
        provider: 'dingtalk',
        corpId: 'corp-a',
        openId: 'another-user',
        assurance: 'mapped',
        mappedUserId: 'user-b',
        role: 'member',
      },
    });
    const test = setup({ content: '继续 W-ABCDEF123456', shortWorkOrder: privateWork });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.stringContaining('找不到你可访问的任务 W-ABCDEF123456'),
      expect.any(String),
      expect.any(Function),
    );
  });

  it('enforces trigger roles against the active governance membership persona', async () => {
    const denied = setup({ triggerRoles: ['org_admin'], governanceRole: 'member' });
    await expect(denied.router.runOnce()).resolves.toBe(true);
    expect(denied.dispatch).not.toHaveBeenCalled();

    const allowed = setup({ triggerRoles: ['org_admin'], governanceRole: 'org_admin' });
    await expect(allowed.router.runOnce()).resolves.toBe(true);
    expect(allowed.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        orgAgentChannel: expect.objectContaining({ actorRole: 'org_admin' }),
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('fails closed when a mapped requester no longer has an active membership', async () => {
    const test = setup({ governanceRole: null });
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.sender.send).toHaveBeenCalledOnce();
  });

  it('does not fall through to a requester-owned legacy session after live deny', async () => {
    const test = setup({ liveDeny: true });
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.messageStore.getOrCreateBinding).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.sender.send).toHaveBeenCalledOnce();
    expect(test.messageStore.reject).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, 'ORG_AGENT_CHANNEL_LIVE_DENY',
    );
  });

  it('visibly rejects an unavailable identity resolver instead of treating it as a guest', async () => {
    const test = setup({
      requesterOutcome: { status: 'unavailable', reason: 'DWS_IDENTITY_LOOKUP_FAILED' },
    });
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.sender.send).toHaveBeenCalledOnce();
    expect(test.messageStore.reject).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, 'DWS_IDENTITY_LOOKUP_FAILED',
    );
  });

  it('keeps an allowed guest in the group scope while topic Context is fail-closed', async () => {
    const test = setup({
      guestReadOnly: true,
      requesterOutcome: { status: 'unmapped', reason: 'DWS_IDENTITY_NOT_MAPPED' },
    });
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        user: undefined,
        orgAgentChannel: expect.objectContaining({
          externalActorAssurance: 'unmapped',
          contextEnabled: false,
        }),
      }),
      expect.objectContaining({ allowedTools: [] }),
      expect.any(Object),
    );
  });

  it('exposes Context tools to a mapped member only when topic Context is enabled', async () => {
    const enabled = setup({ contextEnabled: true });
    await expect(enabled.router.runOnce()).resolves.toBe(true);
    expect(enabled.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        orgAgentChannel: expect.objectContaining({ contextEnabled: true }),
      }),
      expect.objectContaining({
        allowedTools: ['Agent', 'BackgroundTask', 'ContextSearch', 'ContextGet'],
      }),
      expect.any(Object),
    );

    const disabled = setup();
    await expect(disabled.router.runOnce()).resolves.toBe(true);
    expect(disabled.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ allowedTools: ['Agent', 'BackgroundTask'] }),
      expect.any(Object),
    );
  });

  it('does not inject a revoked AgentMemory derived from another group into the next group turn', async () => {
    const sourceMemoryId = 'conversation-memory-group-a';
    const promoted = {
      memoryId: 'agent-memory-a',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      memoryScope: 'agent',
      status: 'active',
      content: { fact: 'A 群受限采购底价' },
      provenance: { messageId: 'message-group-a', sourceMemoryId },
      promotedBy: 'admin-a',
      promotionReason: '管理员确认',
      policyRevision: 1,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const beforeRevocation = setup({ memories: [promoted] });
    await expect(beforeRevocation.router.runOnce()).resolves.toBe(true);
    expect(beforeRevocation.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        systemContext: expect.stringContaining('A 群受限采购底价'),
      }),
      expect.any(Object),
      expect.any(Object),
    );

    const afterRevocation = setup({
      memories: [
        {
          ...promoted,
          status: 'revoked',
          version: 2,
          revokedAt: now,
        },
      ],
    });
    await expect(afterRevocation.router.runOnce()).resolves.toBe(true);
    expect(afterRevocation.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        systemContext: expect.not.stringContaining('A 群受限采购底价'),
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('limits an unmapped guest with shared read-only access to Context tools', async () => {
    const test = setup({
      guestReadOnly: true,
      contextEnabled: true,
      requesterOutcome: { status: 'unmapped', reason: 'DWS_IDENTITY_NOT_MAPPED' },
    });

    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ user: undefined }),
      expect.objectContaining({ allowedTools: ['ContextSearch', 'ContextGet'] }),
      expect.any(Object),
    );
  });

  it('keeps organization DWS write approval durable instead of auto-rejecting it', async () => {
    let interactionResponse: { deferred?: boolean; message?: string } | undefined;
    const dispatch = vi.fn((_message, context, _options, hooks) =>
      (async function* () {
        interactionResponse = await hooks?.onInteraction?.({
          type: 'permission_request',
          interactionId: 'approval-a',
          sessionId: context.resumeSessionId,
          runId: 'run-a',
          toolCallId: 'call-a',
          toolId: 'DwsBusiness',
          toolName: 'DwsBusiness',
          displayName: '钉钉业务操作',
          toolInput: { args: ['doc', 'update', '--node', 'doc-a'], confirmed: true },
        });
        yield { type: 'session_init' as const, sessionId: context.resumeSessionId };
        yield { type: 'done' as const };
      })(),
    ) as unknown as AgentRunDispatch;
    const test = setup({
      dwsBusinessEnabled: true,
      governanceRole: 'org_admin',
    });
    vi.mocked(test.dispatch).mockImplementation(dispatch);

    await expect(test.router.runOnce()).resolves.toBe(false);

    expect(interactionResponse).toEqual({
      deferred: true,
      message: '等待平台管理员审批组织写操作',
    });
    expect(test.messageStore.defer).toHaveBeenCalledWith(
      'inbox-a',
      expect.stringMatching(/^agent-dws-router:/),
      1,
      30_000,
      'Agent DWS organization write is waiting for durable approval',
    );
    expect(test.messageStore.fail).not.toHaveBeenCalled();
    expect(test.messageStore.complete).not.toHaveBeenCalled();
    expect(test.orgStore.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '这项组织写操作已进入审批，管理员批准后我会继续执行并回复结果。',
        source: 'system',
      }),
    );
  });

  it('routes a service completion without resolving or borrowing a requester identity', async () => {
    const completion = {
      ...item,
      senderOpenDingtalkId: undefined,
      workConversationId: 'workconv-a',
      payload: {
        ...item.payload,
        source: 'background_task_completion',
        backgroundTaskId: 'bg-a',
        workOrderId: 'work-a',
        attemptId: 'attempt-a',
        attemptFence: 1,
        workConversationId: 'workconv-a',
      },
    };
    const test = setup({ claimed: completion });
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.resolveRequester).not.toHaveBeenCalled();
    expect(test.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        user: undefined,
        orgAgentChannel: expect.objectContaining({
          externalActorAssurance: 'service',
          externalActor: expect.objectContaining({ kind: 'service_event', workOrderId: 'work-a' }),
        }),
      }),
      expect.objectContaining({ dispatcherCompletion: true, allowedTools: [] }),
      expect.any(Object),
    );
  });

  it('routes requester-only task completion to its pinned creator instead of the group', async () => {
    const completion = {
      ...item,
      senderOpenDingtalkId: undefined,
      workConversationId: 'workconv-a',
      payload: {
        ...item.payload,
        source: 'background_task_completion',
        backgroundTaskId: 'bg-a',
        workOrderId: 'work-a',
        attemptId: 'attempt-a',
        attemptFence: 1,
        workConversationId: 'workconv-a',
      },
    };
    const test = setup({ claimed: completion, workVisibility: 'requester_only' });
    await expect(test.router.runOnce()).resolves.toBe(true);

    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.messageStore.markDispatchStarted).toHaveBeenCalledWith(
      'inbox-a',
      expect.stringMatching(/^agent-dws-router:/),
      1,
      expect.stringMatching(/^agent-dws-private-completion-/),
      expect.any(String),
    );
    expect(test.orgStore.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: 'requester_only',
        destination: expect.objectContaining({
          kind: 'direct',
          peerOpenId: 'requester-open-id',
        }),
      }),
    );
    expect(test.sender.send).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        type: 'user_im_message_receive_o2o_all',
        senderOpenDingtalkId: 'requester-open-id',
      }),
      '任务「整理采购异常」已完成：敏感结果',
      expect.any(String),
      expect.any(Function),
    );
  });

  it('finishes the inbox but leaves a missing provider receipt in unknown for reconciliation', async () => {
    const test = setup({ senderReceipt: null });
    await expect(test.router.runOnce()).resolves.toBe(true);
    expect(test.orgStore.markDeliveryUnknown).toHaveBeenCalledWith(
      'delivery-a',
      expect.stringMatching(/^agent-dws-router:/),
      1,
      expect.any(Error),
    );
    expect(test.messageStore.complete).toHaveBeenCalledOnce();
  });
});
