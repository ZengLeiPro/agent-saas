import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/middleware.js';
import type { GovernanceAuditStore } from '../data/governance-audit/index.js';
import {
  AGENT_DWS_CONTEXT_POLICY_MAX_CONVERSATIONS,
  AGENT_DWS_CONTEXT_POLICY_MAX_LOOKBACK_DAYS,
  AgentDwsAccountInvariantError,
  failClosedAgentDwsContextPolicy,
  hasExactAgentDwsProfile,
  type AgentDwsAccountRecord,
  type AgentDwsAccountStore,
  type AgentDwsContextPolicy,
} from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord, AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import type { OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import type { BackgroundTaskRuntime } from '../runtime/background/backgroundTaskRuntime.js';
import type { OrgAgentStore } from '../data/orgAgents/index.js';
import type { AgentDwsAuthFlowServiceLike } from '../dws/agentAuthFlow.js';
import type { DwsPersonalEventGateway } from '../dws/personalEventGateway.js';
import type { DwsAuthSessionRecord } from '../dws/authStore.js';
import { deriveDwsAgentDelegationResourceId } from '../dws/businessToolProvider.js';

const eventKindSchema = z.enum(['at_me', 'all_direct']);
const createSchema = z.object({
  tenantId: z.string().trim().min(1).max(64).optional(),
  agentId: z.string().trim().min(1).max(96),
  displayName: z.string().trim().min(1).max(40),
  loginId: z.string().trim().min(3).max(128),
  corpId: z.string().trim().min(1).max(512).optional(),
  eventKinds: z.array(eventKindSchema).min(1).max(2).default(['at_me', 'all_direct'])
    .refine(items => new Set(items).size === items.length, 'eventKinds must be unique'),
});
const expectedRevisionSchema = z.object({ expectedRevision: z.number().int().positive() });
const enabledSchema = expectedRevisionSchema.extend({ enabled: z.boolean() });
const conversationIdsSchema = z.array(z.string().trim().min(1).max(256))
  .max(AGENT_DWS_CONTEXT_POLICY_MAX_CONVERSATIONS)
  .refine(items => new Set(items).size === items.length, 'conversationIds must be unique');
const selectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none'), conversationIds: z.array(z.never()).max(0) }).strict(),
  z.object({ mode: z.literal('all'), conversationIds: z.array(z.never()).max(0) }).strict(),
  z.object({ mode: z.literal('selected'), conversationIds: conversationIdsSchema.min(1) }).strict(),
]);
const contextPolicySchema = expectedRevisionSchema.extend({
  historical: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('none'),
      conversationIds: z.array(z.never()).max(0),
      lookbackDays: z.number().int().min(1).max(AGENT_DWS_CONTEXT_POLICY_MAX_LOOKBACK_DAYS),
    }).strict(),
    z.object({
      mode: z.literal('all'),
      conversationIds: z.array(z.never()).max(0),
      lookbackDays: z.number().int().min(1).max(AGENT_DWS_CONTEXT_POLICY_MAX_LOOKBACK_DAYS),
    }).strict(),
    z.object({
      mode: z.literal('selected'),
      conversationIds: conversationIdsSchema.min(1),
      lookbackDays: z.number().int().min(1).max(AGENT_DWS_CONTEXT_POLICY_MAX_LOOKBACK_DAYS),
    }).strict(),
  ]),
  realtime: selectionSchema,
  wiki: z.object({ enabled: z.boolean() }).strict().optional().default({ enabled: false }),
  minutes: z.object({
    enabled: z.boolean(),
    lookbackDays: z.number().int().min(1).max(AGENT_DWS_CONTEXT_POLICY_MAX_LOOKBACK_DAYS),
  }).strict().optional().default({ enabled: false, lookbackDays: 30 }),
}).strict();
const inboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const delegationResourceSchema = z.object({
  args: z.array(z.string().min(1).max(500)).min(1).max(100),
}).strict();
const GROUP_AGENT_TOOL_MAX = new Set([
  'Agent', 'BackgroundTask',
  'ContextSearch', 'ContextGet', 'WebSearch', 'WebFetch',
  'Read', 'Glob', 'Grep', 'ArtifactCreate',
]);
const groupWorkspaceQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const groupWorkspaceUpdateSchema = z.object({
  conversationId: z.string().trim().min(1).max(1024),
  expectedRevision: z.number().int().positive(),
  enabled: z.boolean(),
  policy: z.object({
    enabled: z.boolean(), membership: z.enum(['members', 'members_and_guests']),
    guest: z.enum(['deny', 'shared_read_only']), taskVisibility: z.enum(['conversation', 'requester_only']),
    completion: z.enum(['reply_to_work_conversation', 'silent']), liveDeny: z.boolean(),
  }).strict(),
  effectiveConfig: z.object({
    identity: z.object({ displayName: z.string().trim().min(1).max(80).optional() }).strict(),
    knowledge: z.object({ contextEnabled: z.boolean(), sourceIds: z.array(z.string().min(1).max(200)).max(100) }).strict(),
    capabilities: z.object({ skillIds: z.array(z.string().min(1).max(200)).max(100), toolNames: z.array(z.string().min(1).max(200)).max(100) }).strict(),
    access: z.object({ triggerRoles: z.array(z.string().min(1).max(100)).max(50), approvalRoles: z.array(z.string().min(1).max(100)).max(50) }).strict(),
    speech: z.object({ proactive: z.boolean(), requireMention: z.boolean() }).strict(),
  }).strict(),
}).strict();
const deliveryReconcileSchema = z.object({
  outcome: z.enum(['confirmed_sent', 'confirmed_not_sent', 'indeterminate']),
  reason: z.string().trim().min(1).max(1000),
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
}).strict();
const memoryPromoteSchema = z.object({
  reason: z.string().trim().min(1).max(1000), policyRevision: z.number().int().positive(),
}).strict();
const memoryCreateSchema = z.object({
  bindingId: z.string().trim().min(1), workConversationId: z.string().trim().min(1).optional(),
  workOrderId: z.string().trim().min(1).optional(),
  memoryScope: z.enum(['conversation', 'task_checkpoint']),
  content: z.record(z.string(), z.unknown()), provenance: z.record(z.string(), z.unknown()),
  policyRevision: z.number().int().positive(),
}).strict();
const memoryStatusSchema = z.object({
  expectedVersion: z.number().int().positive(), status: z.enum(['revoked', 'deleted']),
}).strict();
const workOrderActionSchema = z.object({
  expectedVersion: z.number().int().positive(), action: z.enum(['cancel', 'retry']),
}).strict();

class AgentDwsMutationFailure extends Error {
  constructor(
    readonly code:
      | 'AGENT_DWS_AUTH_START_FAILED'
      | 'AGENT_DWS_RUNTIME_SYNC_FAILED'
      | 'AGENT_DWS_CONTEXT_POLICY_SYNC_FAILED',
    readonly changed: boolean,
  ) {
    super(code);
  }
}

export interface AgentDwsAccountsRouterOptions {
  accountStore?: AgentDwsAccountStore;
  messageStore?: Pick<AgentDwsMessageStore, 'listForAccount'>;
  orgGroupAgentStore?: OrgGroupAgentStore;
  orgAgentStore?: Pick<OrgAgentStore, 'get'>;
  backgroundTasks?: BackgroundTaskRuntime;
  authFlowService?: AgentDwsAuthFlowServiceLike;
  eventGateway?: DwsPersonalEventGateway;
  auditStore?: GovernanceAuditStore;
  onContextPolicyUpdated?: (account: AgentDwsAccountRecord) => void | Promise<void>;
  onEnabledChanged?: (account: AgentDwsAccountRecord, enabled: boolean) => void | Promise<void>;
}

export function createAgentDwsAccountsRouter(options: AgentDwsAccountsRouterOptions): Router {
  const router = Router();

  router.get('/agent-dws-accounts', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!options.accountStore) return res.status(503).json({ error: 'Agent 钉钉账号服务暂不可用' });
    const tenantId = tenantFor(req);
    if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    try {
      const accounts = await options.accountStore.listForTenant(tenantId);
      res.json({ accounts: accounts.map(toPublicAccount) });
    } catch {
      res.status(503).json({ error: 'Agent 钉钉账号读取失败' });
    }
  });

  router.get('/agent-dws-accounts/:accountId/inbox', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!options.accountStore || !options.messageStore) {
      return res.status(503).json({ error: 'Agent 钉钉消息诊断服务暂不可用' });
    }
    const parsed = inboxQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const tenantId = tenantFor(req);
    if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    const account = await options.accountStore.getForTenant(tenantId, req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Agent 钉钉账号不存在' });
    try {
      const items = await options.messageStore.listForAccount(
        tenantId,
        account.accountId,
        parsed.data.limit,
      );
      res.json({ items: items.map(toPublicInboxRecord) });
    } catch {
      res.status(503).json({ error: 'Agent 钉钉消息诊断读取失败' });
    }
  });

  router.get('/agent-dws-accounts/:accountId/group-workspace', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!options.accountStore || !options.orgGroupAgentStore || !options.orgAgentStore) return res.status(503).json({ error: '组织群工作台暂不可用' });
    const parsed = groupWorkspaceQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const tenantId = tenantFor(req);
    if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    const account = await options.accountStore.getForTenant(tenantId, req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Agent 钉钉账号不存在' });
    try {
      const [bindings, deliveries] = await Promise.all([
        options.orgGroupAgentStore.listBindings(tenantId, account.accountId),
        options.orgGroupAgentStore.listDeliveries(tenantId, account.accountId, parsed.data.limit),
      ]);
      const workspaces = await Promise.all(bindings.filter(binding => binding.channelKind === 'group').map(async binding => {
        const workOrders = await options.orgGroupAgentStore!.listWorkOrders(tenantId, binding.bindingId, parsed.data.limit);
        return { bindingId: binding.bindingId,
          workOrders: await Promise.all(workOrders.map(async workOrder => ({ ...workOrder,
            attempts: await options.orgGroupAgentStore!.listWorkAttempts(tenantId, workOrder.workOrderId) }))),
          memories: await options.orgGroupAgentStore!.listMemories({ tenantId, agentId: binding.agentId,
            bindingId: binding.bindingId, limit: parsed.data.limit }) };
      }));
      return res.json({ bindings: bindings.map(binding => {
        const agent = options.orgAgentStore!.get(binding.agentId);
        return { ...binding, effectiveConfigComputation: {
          publishedAgent: { skillIds: agent?.allowedSkills ?? [], sourceIds: agent?.allowedKnowledge ?? [],
            executionMode: agent?.runtime?.executionMode ?? 'unavailable', enabled: agent?.enabled === true },
          channelCeiling: { toolNames: [...GROUP_AGENT_TOOL_MAX].sort() },
          groupNarrowing: binding.effectiveConfig,
          liveOverrides: { bindingEnabled: binding.enabled && binding.activationState === 'active',
            liveDeny: binding.policy.liveDeny, accountStatus: account.status },
        } };
      }), workspaces, deliveries: deliveries
        .filter(item => item.destination.kind === 'group')
        .map(toPublicDeliveryRecord) });
    } catch {
      return res.status(503).json({ error: '组织群工作台读取失败' });
    }
  });

  router.patch('/agent-dws-accounts/:accountId/group-workspace', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!options.accountStore || !options.orgGroupAgentStore || !options.orgAgentStore) return res.status(503).json({ error: '组织群工作台暂不可用' });
    const parsed = groupWorkspaceUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const tenantId = tenantFor(req);
    if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    const account = await options.accountStore.getForTenant(tenantId, req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Agent 钉钉账号不存在' });
    const agent = options.orgAgentStore.get(account.agentId);
    if (!agent || agent.tenantId !== tenantId || !agent.enabled) return res.status(409).json({ error: '组织智能体当前不可用' });
    if (parsed.data.enabled && agent.runtime?.executionMode !== 'dispatcher')
      return res.status(409).json({ error: '启用群聊前，组织智能体必须发布为 dispatcher 模式' });
    const invalidSkill = parsed.data.effectiveConfig.capabilities.skillIds.some(id => !agent.allowedSkills.includes(id));
    const invalidSource = parsed.data.effectiveConfig.knowledge.sourceIds.some(id => !(agent.allowedKnowledge ?? []).includes(id));
    const invalidTool = parsed.data.effectiveConfig.capabilities.toolNames.some(name => !GROUP_AGENT_TOOL_MAX.has(name));
    if (invalidSkill || invalidSource || invalidTool) return res.status(400).json({ error: '群配置只能收窄组织智能体已发布的能力' });
    await runMutation(req, res, options, {
      action: 'org_agent.channel_binding.update', tenantId, targetId: account.accountId,
      purpose: 'update group Agent effective configuration',
    }, async () => {
      try {
        const binding = await options.orgGroupAgentStore!.updateBinding({ tenantId, accountId: account.accountId, ...parsed.data });
        return { status: 200, body: { binding } };
      } catch (error) {
        if (error instanceof Error && error.message === 'ORG_AGENT_BINDING_VERSION_CONFLICT') {
          throw new AgentDwsAccountInvariantError('AGENT_DWS_ACCOUNT_REVISION_CONFLICT');
        }
        throw error;
      }
    });
  });

  router.post('/agent-dws-accounts/:accountId/group-workspace/deliveries/:deliveryId/reconcile', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!options.accountStore || !options.orgGroupAgentStore) return res.status(503).json({ error: '组织群工作台暂不可用' });
    const parsed = deliveryReconcileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const tenantId = tenantFor(req); if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    const account = await options.accountStore.getForTenant(tenantId, req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Agent 钉钉账号不存在' });
    return await runMutation(req, res, options, {
      action: 'org_agent.delivery.reconcile', tenantId, targetId: req.params.deliveryId,
      purpose: parsed.data.reason,
    }, async () => ({ status: 200, body: { delivery: await options.orgGroupAgentStore!.reconcileDelivery({
      tenantId, deliveryId: req.params.deliveryId, actorId: req.user!.username,
      reason: parsed.data.reason, evidence: parsed.data.evidence, outcome: parsed.data.outcome,
    }) } }));
  });

  router.post('/agent-dws-accounts/:accountId/group-workspace/work-orders/:workOrderId/action', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!options.accountStore || !options.orgGroupAgentStore || !options.backgroundTasks) {
      return res.status(503).json({ error: '组织群任务服务暂不可用' });
    }
    const parsed = workOrderActionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const tenantId = tenantFor(req); if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    const [account, workOrder] = await Promise.all([
      options.accountStore.getForTenant(tenantId, req.params.accountId),
      options.orgGroupAgentStore.getWorkOrder(tenantId, req.params.workOrderId),
    ]);
    if (!account || !workOrder) return res.status(404).json({ error: '账号或任务不存在' });
    const binding = await options.orgGroupAgentStore.getBindingById(tenantId, workOrder.bindingId);
    if (!binding || binding.accountId !== account.accountId) return res.status(404).json({ error: '任务不属于当前账号' });
    return await runMutation(req, res, options, {
      action: `org_agent.work_order.${parsed.data.action}`, tenantId, targetId: workOrder.workOrderId,
      purpose: `${parsed.data.action} group work order`,
    }, async () => {
      const task = parsed.data.action === 'cancel'
        ? await options.backgroundTasks!.cancelWorkOrder(tenantId, workOrder.workOrderId, parsed.data.expectedVersion)
        : await options.backgroundTasks!.retryWorkOrder(tenantId, workOrder.workOrderId, parsed.data.expectedVersion);
      return { status: 200, body: { task,
        workOrder: await options.orgGroupAgentStore!.getWorkOrder(tenantId, workOrder.workOrderId) } };
    });
  });

  router.post('/agent-dws-accounts/:accountId/group-workspace/memories/:memoryId/promote', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!options.accountStore || !options.orgGroupAgentStore) return res.status(503).json({ error: '组织群工作台暂不可用' });
    const parsed = memoryPromoteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const tenantId = tenantFor(req); if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    const account = await options.accountStore.getForTenant(tenantId, req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Agent 钉钉账号不存在' });
    return await runMutation(req, res, options, {
      action: 'org_agent.memory.promote', tenantId, targetId: req.params.memoryId, purpose: parsed.data.reason,
    }, async () => ({ status: 200, body: { memory: await options.orgGroupAgentStore!.promoteMemory({
      tenantId, sourceMemoryId: req.params.memoryId, promotedBy: req.user!.username,
      reason: parsed.data.reason, policyRevision: parsed.data.policyRevision,
    }) } }));
  });

  router.post('/agent-dws-accounts/:accountId/group-workspace/memories', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!options.accountStore || !options.orgGroupAgentStore) return res.status(503).json({ error: '组织群工作台暂不可用' });
    const parsed = memoryCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const tenantId = tenantFor(req); if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    const account = await options.accountStore.getForTenant(tenantId, req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Agent 钉钉账号不存在' });
    const binding = await options.orgGroupAgentStore.getBindingById(tenantId, parsed.data.bindingId);
    if (!binding || binding.accountId !== account.accountId || binding.agentId !== account.agentId) {
      return res.status(404).json({ error: '群绑定不存在' });
    }
    return await runMutation(req, res, options, {
      action: 'org_agent.memory.create', tenantId, targetId: binding.bindingId, purpose: 'create governed group memory',
    }, async () => ({ status: 201, body: { memory: await options.orgGroupAgentStore!.createMemory({
      tenantId, agentId: binding.agentId, bindingId: binding.bindingId,
      ...(parsed.data.workConversationId ? { workConversationId: parsed.data.workConversationId } : {}),
      ...(parsed.data.workOrderId ? { workOrderId: parsed.data.workOrderId } : {}),
      memoryScope: parsed.data.memoryScope, content: parsed.data.content,
      provenance: { ...parsed.data.provenance, createdBy: req.user!.username },
      policyRevision: parsed.data.policyRevision,
    }) } }));
  });

  router.patch('/agent-dws-accounts/:accountId/group-workspace/memories/:memoryId', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!options.accountStore || !options.orgGroupAgentStore) return res.status(503).json({ error: '组织群工作台暂不可用' });
    const parsed = memoryStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const tenantId = tenantFor(req); if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    const account = await options.accountStore.getForTenant(tenantId, req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Agent 钉钉账号不存在' });
    return await runMutation(req, res, options, {
      action: `org_agent.memory.${parsed.data.status}`, tenantId, targetId: req.params.memoryId,
      purpose: `memory ${parsed.data.status}`,
    }, async () => ({ status: 200, body: { memory: await options.orgGroupAgentStore!.changeMemoryStatus({
      tenantId, memoryId: req.params.memoryId, expectedVersion: parsed.data.expectedVersion,
      status: parsed.data.status,
    }) } }));
  });

  router.post('/agent-dws-accounts/:accountId/delegation-resource', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!options.accountStore) return res.status(503).json({ error: 'Agent 钉钉账号服务暂不可用' });
    const parsed = delegationResourceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'args 必须是非空字符串数组' });
    const tenantId = tenantFor(req);
    if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    const account = await options.accountStore.getForTenant(tenantId, req.params.accountId);
    if (!account || account.status !== 'active' || !hasExactAgentDwsProfile(account)) {
      return res.status(409).json({ error: '仅已完成精确身份授权的启用账号可配置委托范围' });
    }
    return res.json({
      accountId: account.accountId,
      args: parsed.data.args,
      resourceId: deriveDwsAgentDelegationResourceId(account.accountId, parsed.data.args),
    });
  });

  router.post('/agent-dws-accounts', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const tenantId = tenantFor(req, parsed.data.tenantId);
    if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    await runMutation(req, res, options, {
      action: 'agent_dws_account.create',
      tenantId,
      targetId: parsed.data.agentId,
      purpose: 'create Agent-owned DingTalk member connection',
    }, async () => {
      const account = await options.accountStore!.create({
        tenantId,
        agentId: parsed.data.agentId,
        displayName: parsed.data.displayName,
        loginId: parsed.data.loginId,
        ...(parsed.data.corpId ? { corpId: parsed.data.corpId } : {}),
        eventKinds: parsed.data.eventKinds,
        createdBy: req.user!.sub,
      });
      return { status: 201, body: { account: toPublicAccount(account) } };
    });
  });

  router.patch('/agent-dws-accounts/:accountId', async (req, res) => {
    const parsed = enabledSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const tenantId = tenantFor(req);
    if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    await runMutation(req, res, options, {
      action: parsed.data.enabled ? 'agent_dws_account.enable' : 'agent_dws_account.pause',
      tenantId,
      targetId: req.params.accountId,
      purpose: parsed.data.enabled ? 'enable Agent DingTalk member connection' : 'pause Agent DingTalk member connection',
    }, async () => {
      const account = await options.accountStore!.setEnabled(
        tenantId,
        req.params.accountId,
        parsed.data.enabled,
        parsed.data.expectedRevision,
        req.user!.sub,
      );
      try {
        if (!parsed.data.enabled) {
          await options.authFlowService?.cancel(tenantId, account.accountId);
          await options.eventGateway?.stopAccount(account.accountId);
        } else if (account.status === 'active') {
          await options.eventGateway?.startAccount(account);
        }
        await options.onEnabledChanged?.(account, parsed.data.enabled);
      } catch {
        throw new AgentDwsMutationFailure('AGENT_DWS_RUNTIME_SYNC_FAILED', true);
      }
      return { status: 200, body: { account: toPublicAccount(account) } };
    });
  });

  router.patch('/agent-dws-accounts/:accountId/context-policy', async (req, res) => {
    const parsed = contextPolicySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const tenantId = tenantFor(req);
    if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    await runMutation(req, res, options, {
      action: 'agent_dws_account.update_context_policy',
      tenantId,
      targetId: req.params.accountId,
      purpose: 'update Agent DingTalk chat context learning and realtime listening policy',
    }, async () => {
      const previous = await options.accountStore!.getForTenant(tenantId, req.params.accountId);
      const account = await options.accountStore!.setContextPolicy(
        tenantId,
        req.params.accountId,
        withRealtimeConsentTimestamps({
          historical: parsed.data.historical,
          realtime: parsed.data.realtime,
          wiki: parsed.data.wiki,
          minutes: parsed.data.minutes,
        }, previous?.contextPolicy),
        parsed.data.expectedRevision,
        req.user!.sub,
      );
      try {
        await options.onContextPolicyUpdated?.(account);
      } catch {
        throw new AgentDwsMutationFailure('AGENT_DWS_CONTEXT_POLICY_SYNC_FAILED', true);
      }
      return { status: 200, body: { account: toPublicAccount(account) } };
    });
  });

  router.post('/agent-dws-accounts/:accountId/authorize', async (req, res) => {
    const parsed = expectedRevisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    if (!options.authFlowService) return res.status(503).json({ error: 'Agent 钉钉授权服务暂不可用' });
    const tenantId = tenantFor(req);
    if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    await runMutation(req, res, options, {
      action: 'agent_dws_account.authorize',
      tenantId,
      targetId: req.params.accountId,
      purpose: 'start Agent DingTalk member OAuth device flow',
    }, async () => {
      const account = await options.accountStore!.markAuthorizing(
        tenantId,
        req.params.accountId,
        parsed.data.expectedRevision,
        req.user!.sub,
      );
      try {
        await options.eventGateway?.stopAccount(account.accountId);
        const session = await options.authFlowService!.start(account);
        return {
          status: 202,
          body: { account: toPublicAccount(account), session: toPublicAuthSession(session) },
        };
      } catch {
        await options.accountStore!.markAuthorizationFailed(
          account.tenantId,
          account.accountId,
          account.revision,
          'authorization_start_failed',
          'system:agent-dws-auth',
        ).catch(() => undefined);
        throw new AgentDwsMutationFailure('AGENT_DWS_AUTH_START_FAILED', true);
      }
    });
  });

  router.get('/agent-dws-accounts/:accountId/auth/session', async (req, res) => {
    if (!options.accountStore || !options.authFlowService) {
      return res.status(503).json({ error: 'Agent 钉钉授权服务暂不可用' });
    }
    const tenantId = tenantFor(req);
    if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    const account = await options.accountStore.getForTenant(tenantId, req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Agent 钉钉账号不存在' });
    try {
      const session = await options.authFlowService.getLatest(tenantId, account.accountId);
      res.json({ session: session ? toPublicAuthSession(session) : null });
    } catch {
      res.status(503).json({ error: 'Agent 钉钉授权状态读取失败' });
    }
  });

  router.post('/agent-dws-accounts/:accountId/restart-stream', async (req, res) => {
    if (!options.eventGateway) return res.status(503).json({ error: 'DWS Personal Stream 网关暂不可用' });
    const tenantId = tenantFor(req);
    if (!tenantId) return res.status(403).json({ error: '跨组织访问被拒绝' });
    const account = await options.accountStore?.getForTenant(tenantId, req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Agent 钉钉账号不存在' });
    if (account.status !== 'active' || !hasExactAgentDwsProfile(account)) {
      return res.status(409).json({ error: '账号尚未完成授权或已暂停' });
    }
    await runMutation(req, res, options, {
      action: 'agent_dws_account.restart_stream',
      tenantId,
      targetId: account.accountId,
      purpose: 'restart Agent DingTalk personal event stream',
    }, async () => {
      try {
        await options.eventGateway!.stopAccount(account.accountId);
        await options.eventGateway!.startAccount(account);
      } catch {
        throw new AgentDwsMutationFailure('AGENT_DWS_RUNTIME_SYNC_FAILED', true);
      }
      return { status: 202, body: { account: toPublicAccount({ ...account, runtimeStatus: 'starting', lastError: undefined }) } };
    });
  });

  return router;
}

async function runMutation(
  req: Request,
  res: Response,
  options: AgentDwsAccountsRouterOptions,
  meta: { action: string; tenantId: string; targetId: string; purpose: string },
  mutate: () => Promise<{ status: number; body: Record<string, unknown> }>,
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!options.accountStore) {
    res.status(503).json({ error: 'Agent 钉钉账号服务暂不可用' });
    return;
  }
  if (!options.auditStore) {
    res.status(503).json({ error: '治理审计不可用', code: 'GOVERNANCE_AUDIT_UNAVAILABLE' });
    return;
  }
  const correlationId = `agent-dws-account:${randomUUID()}`;
  let intentId: string;
  try {
    const intent = await options.auditStore.append({
      correlationId,
      actorType: 'user',
      actorUserId: req.user.sub,
      actorPersona: isPlatformAdmin(req.user) ? 'platform_admin' : 'org_admin',
      actorTenantId: req.user.tenantId,
      action: meta.action,
      targetType: 'agent_dws_account',
      targetId: meta.targetId,
      targetTenantId: meta.tenantId,
      purpose: meta.purpose,
      result: 'intent',
      metadata: {},
    });
    intentId = intent.auditId;
  } catch {
    res.status(503).json({ error: '治理审计不可用', code: 'GOVERNANCE_AUDIT_UNAVAILABLE' });
    return;
  }

  let result: { status: number; body: Record<string, unknown> };
  try {
    result = await mutate();
  } catch (error) {
    const mapped = mapError(error);
    try {
      await options.auditStore.append({
        correlationId,
        changeId: intentId,
        actorType: 'user',
        actorUserId: req.user.sub,
        actorPersona: isPlatformAdmin(req.user) ? 'platform_admin' : 'org_admin',
        actorTenantId: req.user.tenantId,
        action: meta.action,
        targetType: 'agent_dws_account',
        targetId: meta.targetId,
        targetTenantId: meta.tenantId,
        purpose: meta.purpose,
        result: 'failed',
        metadata: { statusCode: mapped.status },
      });
    } catch {
      res.status(500).json({
        error: '操作失败且终态审计未能持久化',
        code: 'GOVERNANCE_AUDIT_TERMINAL_NOT_DURABLE',
        changed: mapped.changed,
        auditId: intentId,
      });
      return;
    }
    res.status(mapped.status).json({
      error: mapped.message,
      code: mapped.code,
      ...(mapped.changed ? { changed: true } : {}),
      auditId: intentId,
    });
    return;
  }

  try {
    const terminal = await options.auditStore.append({
      correlationId,
      changeId: intentId,
      actorType: 'user',
      actorUserId: req.user.sub,
      actorPersona: isPlatformAdmin(req.user) ? 'platform_admin' : 'org_admin',
      actorTenantId: req.user.tenantId,
      action: meta.action,
      targetType: 'agent_dws_account',
      targetId: meta.targetId,
      targetTenantId: meta.tenantId,
      purpose: meta.purpose,
      result: 'succeeded',
      metadata: { statusCode: result.status },
    });
    res.status(result.status).json({ ...result.body, changeId: intentId, auditId: terminal.auditId });
  } catch {
    res.status(500).json({
      error: '变更已执行，但终态审计未能持久化',
      code: 'GOVERNANCE_AUDIT_TERMINAL_NOT_DURABLE',
      changed: true,
      auditId: intentId,
    });
  }
}

function tenantFor(req: Request, requested?: string): string | null {
  if (!req.user) return null;
  if (isPlatformAdmin(req.user)) return requested ?? queryTenant(req) ?? null;
  if (requested && requested !== req.user.tenantId) return null;
  return req.user.tenantId;
}

function queryTenant(req: Request): string | undefined {
  return typeof req.query.tenantId === 'string' && req.query.tenantId.trim()
    ? req.query.tenantId.trim()
    : undefined;
}

function withRealtimeConsentTimestamps(
  policy: AgentDwsContextPolicy,
  previous: AgentDwsContextPolicy | undefined,
  now = new Date().toISOString(),
): AgentDwsContextPolicy {
  const previousPolicy = previous ?? failClosedAgentDwsContextPolicy();
  const previousMarkers = previousPolicy.realtimeEffectiveAt;
  if (policy.realtime.mode === 'none') return { ...policy, realtimeEffectiveAt: {} };
  if (policy.realtime.mode === 'all') {
    const alreadyAllowed = previousPolicy.realtime.mode === 'all';
    return {
      ...policy,
      realtimeEffectiveAt: {
        all: alreadyAllowed ? previousMarkers?.all ?? previousPolicy.effectiveAt ?? now : now,
      },
    };
  }
  const conversations: Record<string, string> = {};
  for (const conversationId of policy.realtime.conversationIds) {
    const inherited = previousPolicy.realtime.mode === 'all'
      ? previousMarkers?.all ?? previousPolicy.effectiveAt
      : previousPolicy.realtime.mode === 'selected'
        && previousPolicy.realtime.conversationIds.includes(conversationId)
        ? previousMarkers?.conversations?.[conversationId] ?? previousPolicy.effectiveAt
        : undefined;
    conversations[conversationId] = inherited ?? now;
  }
  return { ...policy, realtimeEffectiveAt: { conversations } };
}

function toPublicAccount(account: AgentDwsAccountRecord): Record<string, unknown> {
  return {
    accountId: account.accountId,
    tenantId: account.tenantId,
    agentId: account.agentId,
    displayName: account.displayName,
    loginIdMasked: maskLoginId(account.loginId),
    corpId: account.corpId ?? null,
    corpName: account.corpName ?? null,
    dingtalkUserId: account.dingtalkUserId ?? null,
    dingtalkUserName: account.dingtalkUserName ?? null,
    profileId: account.profileId ?? null,
    status: account.status,
    runtimeStatus: account.runtimeStatus,
    eventKinds: account.eventKinds,
    contextPolicy: account.contextPolicy ?? failClosedAgentDwsContextPolicy(),
    lastEventAt: account.lastEventAt ?? null,
    lastError: account.lastError ?? null,
    revision: account.revision,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function toPublicInboxRecord(record: AgentDwsInboxRecord): Record<string, unknown> {
  return {
    inboxId: record.inboxId,
    eventId: record.eventId,
    eventType: record.eventType,
    conversationId: record.conversationId,
    messageId: record.messageId ?? null,
    state: record.state,
    sessionId: record.sessionId ?? null,
    runId: record.runId ?? null,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    nextAttemptAt: record.nextAttemptAt ?? null,
    lastError: record.lastError ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt ?? null,
  };
}

function toPublicDeliveryRecord(record: Awaited<ReturnType<OrgGroupAgentStore['listDeliveries']>>[number]): Record<string, unknown> {
  return {
    deliveryId: record.deliveryId, inboxId: record.inboxId ?? null,
    conversationId: record.conversationId, workConversationId: record.workConversationId ?? null,
    source: record.source, deliveryKind: record.deliveryKind, disposition: record.disposition,
    content: record.content, sourceWorkOrderId: record.sourceWorkOrderId ?? null,
    sourceAttemptId: record.sourceAttemptId ?? null,
    deliveryState: record.deliveryState, attempt: record.attempt, lastError: record.lastError ?? null,
    lastAttemptAt: record.lastAttemptAt ?? null, createdAt: record.createdAt, updatedAt: record.updatedAt,
    completedAt: record.completedAt ?? null,
  };
}

function maskLoginId(value: string): string {
  if (value.length <= 4) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function toPublicAuthSession(row: DwsAuthSessionRecord): Record<string, unknown> {
  const expired = Date.parse(row.expiresAt) <= Date.now()
    && (row.status === 'starting' || row.status === 'awaiting_user');
  const status = expired ? 'expired' : row.status;
  return {
    sessionId: row.sessionId,
    status,
    authorizationUrl: status === 'awaiting_user' ? row.authorizationUrl ?? null : null,
    userCode: status === 'awaiting_user' ? row.userCode ?? null : null,
    expiresAt: row.expiresAt,
    message: authMessage(status, row.errorMessage),
  };
}

function authMessage(status: string, error?: string): string {
  if (status === 'starting') return '正在生成 Agent 专属钉钉账号授权页面';
  if (status === 'awaiting_user') return '请用 Agent 专属钉钉账号确认授权';
  if (status === 'connected') return 'Agent 钉钉账号已连接，Personal Stream 将自动启动';
  if (status === 'expired') return '授权码已过期，请重新授权';
  return error || '钉钉授权未完成，请重试';
}

function mapError(error: unknown): { status: number; code: string; message: string; changed: boolean } {
  if (error instanceof AgentDwsMutationFailure) {
    return {
      status: 503,
      code: error.code,
      message: error.code === 'AGENT_DWS_AUTH_START_FAILED'
        ? '账号状态已更新，但钉钉授权流程未能启动，请刷新后重试'
        : error.code === 'AGENT_DWS_CONTEXT_POLICY_SYNC_FAILED'
          ? 'Context 范围已保存，但检索策略同步失败，请刷新后重试'
          : '账号状态已更新，但 Personal Stream 同步失败，请刷新查看运行状态',
      changed: error.changed,
    };
  }
  if (error instanceof AgentDwsAccountInvariantError) {
    if (error.code === 'AGENT_DWS_ACCOUNT_NOT_FOUND') {
      return { status: 404, code: error.code, message: 'Agent 钉钉账号不存在', changed: false };
    }
    if (error.code === 'AGENT_DWS_ACCOUNT_CONFLICT') {
      return { status: 409, code: error.code, message: '该组织智能体已经配置钉钉账号', changed: false };
    }
    if (error.code === 'AGENT_DWS_ACCOUNT_REVISION_CONFLICT') {
      return { status: 409, code: error.code, message: '账号配置已被其他管理员更新，请刷新后重试', changed: false };
    }
    if (error.code === 'AGENT_DWS_ACCOUNT_AGENT_INVALID') {
      return { status: 400, code: error.code, message: '组织智能体不存在、已归档或不属于当前组织', changed: false };
    }
  }
  return {
    status: 503,
    code: 'AGENT_DWS_ACCOUNT_OPERATION_FAILED',
    message: 'Agent 钉钉账号操作失败，请稍后重试',
    changed: false,
  };
}
