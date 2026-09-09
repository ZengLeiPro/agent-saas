import { relative, sep } from 'node:path';

import type { ToolCallContext } from '../agent/toolCallContext.js';
import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import {
  hasExactAgentDwsProfile,
  type AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord, AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import type { BackgroundTaskRuntime } from '../runtime/background/backgroundTaskRuntime.js';
import { isOrgAgentControlCommandUnsettledError } from '../runtime/background/orgAgentControlCommandSettlement.js';
import { deriveOrgAgentSharedView } from '../runtime/orgAgentTaskWorkspace.js';
import { resolveAgentCwd } from '../workspace/resolver.js';
import { buildOrgAgentSharedContext, serviceIdentity } from './personalMessageRouterHelpers.js';
import { sharedAllowedTools } from './orgAgentGroupPolicy.js';
import type { SharedGroupContext } from './orgAgentSharedGroupContext.js';
import { resolveSharedGroupContext } from './orgAgentSharedGroupContext.js';
import {
  legacyRequesterResolution,
  matchesInboxAccountIdentity,
  compactError,
} from './personalMessageRouterHelpers.js';
import type { DwsRequesterResolution } from './requesterIdentityResolver.js';
import type { UserIdentity } from '../types/index.js';
import { finalizeReplyDelivery, type OrgAgentVisibleReplyService } from './orgAgentVisibleReply.js';

export type OrgAgentFastControl = {
  taskId?: string;
  action: 'status' | 'cancel' | 'pause' | 'resume' | 'amend';
  text?: string;
};

const ACTIONS: Record<string, OrgAgentFastControl['action']> = {
  status: 'status',
  状态: 'status',
  cancel: 'cancel',
  取消: 'cancel',
  pause: 'pause',
  暂停: 'pause',
  resume: 'resume',
  恢复: 'resume',
  amend: 'amend',
  补充: 'amend',
};
const SHORT_ID = 'W-[A-F0-9]{12}';
const ACTION = 'status|cancel|pause|resume|amend|状态|取消|暂停|恢复|补充';
const PREFIX = new RegExp(`^\\s*(${ACTION})\\s+(${SHORT_ID})(?:\\s+([\\s\\S]+))?\\s*$`, 'iu');
const SUFFIX = new RegExp(`^\\s*(${SHORT_ID})\\s+(${ACTION})(?:\\s+([\\s\\S]+))?\\s*$`, 'iu');
const CONTEXTUAL_MUTATION = /^\s*(取消|暂停|恢复)\s*(?:(?:这个|当前)\s*)?任务\s*$/u;
const CONTEXTUAL_STATUS = /^\s*(?:查看|查询)?\s*(?:(?:这个|当前)\s*)?任务\s*(?:状态|进度)\s*$/u;

export function parseOrgAgentFastControl(content: string): OrgAgentFastControl | null {
  const match = PREFIX.exec(content) ?? SUFFIX.exec(content);
  if (match) {
    const prefix = ACTIONS[match[1]!.toLowerCase()];
    const action = prefix ?? ACTIONS[match[2]!.toLowerCase()];
    const taskId = (prefix ? match[2] : match[1])!.toUpperCase();
    const text = match[3]?.trim();
    if (!action || (action === 'amend') !== Boolean(text)) return null;
    return { taskId, action, ...(text ? { text } : {}) };
  }
  const contextualMutation = CONTEXTUAL_MUTATION.exec(content);
  if (contextualMutation) return { action: ACTIONS[contextualMutation[1]!]! };
  if (CONTEXTUAL_STATUS.test(content)) return { action: 'status' };
  return null;
}

export function createFastControlToolContext(input: {
  agentCwd: string;
  account: AgentDwsAccountRecord;
  item: AgentDwsInboxRecord;
  shared: SharedGroupContext;
}): ToolCallContext {
  const { account, item, shared } = input;
  const agentRoot = resolveAgentCwd(input.agentCwd, account.tenantId, account.agentId);
  const view = deriveOrgAgentSharedView({
    agentRoot,
    agentMountSubPath: relative(input.agentCwd, agentRoot).split(sep).join('/'),
    bindingId: shared.binding.bindingId,
    workConversationId: shared.workConversation.workConversationId,
  });
  const sessionId = shared.binding.serviceSessionId;
  return {
    sessionId,
    runId: `dws-control:${item.inboxId}`,
    workspace: {
      id: shared.binding.workspaceId,
      root: view.root,
      userId: account.accountId,
      username: account.displayName,
      tenantId: account.tenantId,
      sessionId,
      executionTarget: 'server-container',
    },
    channelContext: {
      channel: 'dingtalk',
      user: shared.requester ?? undefined,
      sessionOwner: serviceIdentity(account),
      orgAgentChannel: {
        bindingId: shared.binding.bindingId,
        accountId: shared.binding.accountId,
        agentId: shared.binding.agentId,
        conversationSpaceId: shared.binding.conversationSpaceId,
        workConversationId: shared.workConversation.workConversationId,
        policyRevision: shared.binding.revision,
        agentPrincipal: {
          kind: 'org_agent',
          tenantId: shared.binding.tenantId,
          agentId: shared.binding.agentId,
          accountId: shared.binding.accountId,
          workspaceId: shared.binding.workspaceId,
        },
        externalActorAssurance:
          shared.externalActor.kind === 'external_user'
            ? shared.externalActor.assurance
            : 'service',
        allowedToolNames: sharedAllowedTools(shared),
        allowedSkillIds: [...shared.binding.effectiveConfig.capabilities.skillIds],
        allowedSourceIds: [...shared.binding.effectiveConfig.knowledge.sourceIds],
        dwsResourceIds: [...shared.binding.effectiveConfig.capabilities.dwsResourceIds],
        sharedContext: buildOrgAgentSharedContext(shared),
        contextEnabled: shared.binding.effectiveConfig.knowledge.contextEnabled,
        taskVisibility: shared.binding.policy.taskVisibility,
        ...(shared.governanceRole ? { actorRole: shared.governanceRole } : {}),
        triggerRoles: [...shared.binding.effectiveConfig.access.triggerRoles],
        approvalRoles: [...shared.binding.effectiveConfig.access.approvalRoles],
        externalActor: shared.externalActor,
        channelPrincipal: {
          provider: 'dingtalk',
          accountId: shared.binding.accountId,
          conversationId: shared.binding.conversationId,
          kind: 'group',
        },
      },
    },
  };
}

export async function executeFastControl(input: {
  runtime: Pick<BackgroundTaskRuntime, 'get' | 'cancel' | 'controlWorkOrder'>;
  context: ToolCallContext;
  request: OrgAgentFastControl & {
    taskId: string;
    durableResult?: import('../data/orgGroupAgents/index.js').OrgAgentControlInboxReceipt;
  };
}): Promise<string> {
  const existing = await input.runtime.get(input.context, input.request.taskId);
  if (!existing) throw new Error('任务不存在，或不属于当前群与话题');
  if (input.request.action === 'status')
    return `任务 ${input.request.taskId} 当前状态：${existing.status}`;
  if (input.request.action === 'cancel') {
    const cancelled = await input.runtime.cancel(input.context, input.request.taskId);
    return `任务 ${input.request.taskId} 已取消（${cancelled.status}）`;
  }
  const expectedState = input.request.action === 'pause' ? 'paused' : 'queued';
  const responseText = `任务 ${input.request.taskId} 已${actionLabel(input.request.action)}，当前状态：${expectedState}`;
  const result = await input.runtime.controlWorkOrder(input.context, {
    taskId: input.request.taskId,
    action: input.request.action,
    ...(input.request.text ? { text: input.request.text } : {}),
    ...(input.request.durableResult
      ? { durableResult: { ...input.request.durableResult, responseText } }
      : {}),
  });
  return input.request.durableResult
    ? responseText
    : `任务 ${result.workOrder.shortId} 已${actionLabel(input.request.action)}，当前状态：${result.workOrder.state}`;
}

function actionLabel(action: Exclude<OrgAgentFastControl['action'], 'status' | 'cancel'>): string {
  return action === 'pause' ? '暂停' : action === 'resume' ? '恢复' : '补充要求';
}

export class OrgAgentFastControlPump {
  private active?: Promise<void>;
  private abort?: AbortController;
  private pumping = false;
  private stopped = false;

  constructor(
    private readonly options: {
      agentCwd: string;
      messageStore: AgentDwsMessageStore;
      accountStore: AgentDwsAccountStore;
      runtime: Pick<BackgroundTaskRuntime, 'get' | 'cancel' | 'controlWorkOrder'>;
      visibleReply: OrgAgentVisibleReplyService;
      leaseTtlMs: number;
      leaseRenewMs: number;
      sharedOptions: Parameters<typeof resolveSharedGroupContext>[0];
      resolveRequester: (
        account: AgentDwsAccountRecord,
        openId: string,
        name?: string,
      ) => Promise<UserIdentity | null> | UserIdentity | null;
      resolveRequesterOutcome?: (
        account: AgentDwsAccountRecord,
        openId: string,
        name?: string,
      ) => Promise<DwsRequesterResolution> | DwsRequesterResolution;
      authorizeRequester(input: {
        account: AgentDwsAccountRecord;
        requester: UserIdentity;
        sessionId: string;
        runId: string;
      }): Promise<{ allowed: boolean; reason?: string }>;
      reject(
        account: AgentDwsAccountRecord,
        item: AgentDwsInboxRecord,
        reason: string,
        requester: UserIdentity | undefined,
        owner: string,
      ): Promise<void>;
      warn?(message: string): void;
    },
  ) {}

  kick(): void {
    if (this.stopped || this.pumping || this.active) return;
    this.pumping = true;
    let processed = false;
    this.active = this.runOnce()
      .then((value) => {
        processed = value;
      })
      .catch((error) => {
        this.options.warn?.(`Agent DWS control claim failed: ${compactError(error)}`);
      })
      .finally(() => {
        this.active = undefined;
        this.pumping = false;
        if (processed) this.kick();
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    await this.active?.catch(() => undefined);
  }

  async runOnce(): Promise<boolean> {
    const claim = this.options.messageStore.claimNextControl;
    if (this.stopped || !claim) return false;
    const owner = 'agent-dws-control';
    const item = await claim.call(this.options.messageStore, owner, this.options.leaseTtlMs);
    if (!item) return false;
    const abort = new AbortController();
    this.abort = abort;
    const heartbeat = setInterval(
      () =>
        void this.options.messageStore
          .renewLease(item.inboxId, owner, item.leaseFence, this.options.leaseTtlMs)
          .then((ok) => {
            if (!ok) abort.abort();
          })
          .catch(() => abort.abort()),
      this.options.leaseRenewMs,
    );
    heartbeat.unref?.();
    try {
      await this.process(item, owner, abort);
      return true;
    } catch (error) {
      await this.options.messageStore
        .fail(item.inboxId, owner, item.leaseFence, error)
        .catch(() => undefined);
      return false;
    } finally {
      clearInterval(heartbeat);
      if (this.abort === abort) this.abort = undefined;
    }
  }

  private async process(item: AgentDwsInboxRecord, owner: string, abort: AbortController) {
    const request = parseOrgAgentFastControl(item.content);
    if (!request) {
      await this.options.messageStore.reject(
        item.inboxId,
        owner,
        item.leaseFence,
        'ORG_AGENT_FAST_CONTROL_INVALID',
      );
      return;
    }
    const account = await this.options.accountStore.getForTenant(item.tenantId, item.accountId);
    if (
      !account ||
      account.status !== 'active' ||
      !hasExactAgentDwsProfile(account) ||
      !matchesInboxAccountIdentity(item, account)
    )
      throw new Error('ORG_AGENT_FAST_CONTROL_IDENTITY_STALE');
    if (!item.senderOpenDingtalkId) throw new Error('ORG_AGENT_FAST_CONTROL_REQUESTER_MISSING');
    const senderName =
      typeof item.payload.senderName === 'string' ? item.payload.senderName : undefined;
    const resolution = this.options.resolveRequesterOutcome
      ? await this.options.resolveRequesterOutcome(account, item.senderOpenDingtalkId, senderName)
      : await legacyRequesterResolution(
          this.options.resolveRequester,
          account,
          item.senderOpenDingtalkId,
          senderName,
        );
    if (resolution.status !== 'resolved')
      return await this.options.reject(account, item, resolution.reason, undefined, owner);
    const requester = resolution.requester;
    const sharedResult = await resolveSharedGroupContext(
      this.options.sharedOptions,
      account,
      item,
      requester,
      senderName,
    );
    if (sharedResult.state !== 'active') {
      if (sharedResult.state === 'denied')
        return await this.options.reject(account, item, sharedResult.reason, requester, owner);
      throw new Error('ORG_AGENT_FAST_CONTROL_CHANNEL_UNAVAILABLE');
    }
    const shared = sharedResult.context;
    if (
      request.taskId &&
      !shared.visibleWorkOrders.some((work) => work.shortId.toUpperCase() === request.taskId)
    )
      return await this.options.reject(
        account,
        item,
        'ORG_AGENT_WORK_ORDER_MUTATION_DENIED',
        requester,
        owner,
      );
    const authorization = await this.options.authorizeRequester({
      account,
      requester,
      sessionId: shared.binding.serviceSessionId,
      runId: `dws-control:${item.inboxId}`,
    });
    if (!authorization.allowed)
      return await this.options.reject(
        account,
        item,
        authorization.reason ?? 'ACCESS_DENIED',
        requester,
        owner,
      );
    if (abort.signal.aborted) throw new Error('ORG_AGENT_FAST_CONTROL_LEASE_LOST');
    const context = createFastControlToolContext({
      agentCwd: this.options.agentCwd,
      account,
      item,
      shared,
    });
    let response = item.responseText;
    let responsePersistedWithMutation = false;
    if (response === undefined) {
      const contextualTask = request.taskId ? undefined : shared.visibleWorkOrders[0];
      if (!request.taskId && shared.visibleWorkOrders.length !== 1) {
        response = contextualControlClarification(shared);
      } else {
        const resolvedRequest = {
          ...request,
          taskId: request.taskId ?? contextualTask!.shortId.toUpperCase(),
          durableResult: {
            inboxId: item.inboxId,
            leaseOwner: owner,
            leaseFence: item.leaseFence,
            responseText: '',
          },
        };
        try {
          response = await executeFastControl({
            runtime: this.options.runtime,
            context,
            request: resolvedRequest,
          });
          responsePersistedWithMutation = !['status', 'cancel'].includes(request.action);
        } catch (error) {
          if (isOrgAgentControlCommandUnsettledError(error)) throw error;
          response = `未能执行 ${resolvedRequest.taskId} 的控制操作：${compactError(error)}`;
        }
      }
      if (!responsePersistedWithMutation)
        await this.options.messageStore.saveDispatchResult(
          item.inboxId,
          owner,
          item.leaseFence,
          response,
        );
    }
    await this.options.messageStore.markReplyAttemptStarted(item.inboxId, owner, item.leaseFence);
    const delivery = await this.options.visibleReply.send(
      account,
      item,
      response,
      shared,
      'front_reply',
      'replied',
      'first',
      'system',
    );
    if (await finalizeReplyDelivery(this.options.messageStore, owner, item, delivery))
      await this.options.messageStore.complete(item.inboxId, owner, item.leaseFence);
  }
}

function contextualControlClarification(shared: SharedGroupContext): string {
  if (shared.routingClarification) return shared.routingClarification;
  return '我还不能确定你指哪项任务。请回复/引用原任务消息，或带上任务短号再说一次。';
}
