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
  type AgentDwsAccountRecord,
  type AgentDwsAccountStore,
  type AgentDwsContextPolicy,
} from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord, AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import type { AgentDwsAuthFlowServiceLike } from '../dws/agentAuthFlow.js';
import type { DwsPersonalEventGateway } from '../dws/personalEventGateway.js';
import type { DwsAuthSessionRecord } from '../dws/authStore.js';

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
    if (account.status !== 'active' || !account.profileId) {
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
