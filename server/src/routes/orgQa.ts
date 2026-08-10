/**
 * 组织对话质检台路由（/api/admin/qa，2026-07 唯恩批次）
 *
 * 四端点（均 requireAdmin + 租户强制，复刻 platformObservability 的
 * resolveTenant：平台 admin 可传 ?tenantId=，组织 admin 传别人的 403）：
 *
 * 1. GET /sessions                       — 专职 Agent 会话列表（cursor 分页；
 *    orgAgentId 过滤走 sessionProjectionStore meta_json，不传 = 全部专职会话）
 * 2. GET /sessions/:sessionId/messages   — 会话消息（**新权限路径**：组织管理权力，
 *    projection get({tenantId}) 404 守卫防跨租户枚举 → transcript 解析 →
 *    不调 canAccessSession + auditLog('qa_session_opened')）
 * 3. GET /guardrail-events               — 门禁拒绝/打标日志（offset 分页）
 * 4. GET /feedback                       — 用户反馈标注（offset 分页）
 *
 * PG 依赖未装配（file backend）→ 503，前端 unavailable 隐藏。
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/types.js';
import { TENANT_SLUG_PATTERN } from '../data/tenants/types.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import type { GuardrailEventStore } from '../data/guardrail/pgGuardrailEventStore.js';
import type { MessageFeedbackStore } from '../data/feedback/store.js';
import type { PgSessionProjectionStore } from '../runtime/sessionProjectionStore.js';
import type { UserStore } from '../data/users/store.js';
import {
  findTranscriptPathBySessionId,
  isValidSessionId,
  parseTranscriptFile,
  type TranscriptBlock,
} from '../data/transcripts/index.js';
import { auditLog } from '../data/login-logs/index.js';

const queryTenantSchema = z.object({
  tenantId: z.string().regex(TENANT_SLUG_PATTERN).optional(),
});

const listQaSessionsQuerySchema = queryTenantSchema.extend({
  orgAgentId: z.string().max(64).optional(),
  userId: z.string().max(128).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const listGuardrailEventsQuerySchema = queryTenantSchema.extend({
  orgAgentId: z.string().max(64).optional(),
  userId: z.string().max(128).optional(),
  verdict: z.enum(['off_topic', 'pass_flagged']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const listFeedbackQuerySchema = queryTenantSchema.extend({
  orgAgentId: z.string().max(64).optional(),
  userId: z.string().max(128).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

interface CursorValue {
  updatedAt: string;
  id: string;
}

/** projection store 的结构化读接口（测试可注入内存实现；PG 实现天然满足） */
export type QaSessionProjectionReader = Pick<PgSessionProjectionStore, 'get' | 'list'>;

export interface OrgQaRouterDeps {
  sessionProjectionStore?: QaSessionProjectionReader;
  orgAgentStore?: OrgAgentStore;
  guardrailEventStore?: GuardrailEventStore;
  messageFeedbackStore?: MessageFeedbackStore;
  userStore?: UserStore;
  authorizeAdminAccess?: (input: {
    userId: string;
    tenantId: string;
    platformAdmin: boolean;
  }) => Promise<boolean>;
  authorizeContentAccess?: (input: {
    tenantId: string;
    subjectUserId: string;
    targetType: 'session' | 'guardrail_collection';
    targetId: string;
    scope: 'qa_read' | 'guardrail_read';
  }) => Promise<boolean>;
  auditContentAccess?: (input: {
    tenantId: string;
    actorUserId: string;
    actorTenantId: string;
    actorPersona: 'platform_admin' | 'org_admin';
    sessionId: string;
    scope: 'qa_read';
  }) => Promise<string>;
  /** 测试注入：按 sessionId 定位 transcript（默认全局扫描新 layout） */
  resolveTranscriptPath?: (sessionId: string) => Promise<string | null>;
}

export function maskQaBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  return blocks.map(block => {
    const attachments = block.attachments?.map(attachment => ({
      name: attachment.name,
      ...(attachment.isImage !== undefined ? { isImage: attachment.isImage } : {}),
    }));
    if (block.kind === 'tool_use' || block.kind === 'tool_result' || block.kind === 'thinking') {
      return {
        id: block.id,
        ...(block.tsMs !== undefined ? { tsMs: block.tsMs } : {}),
        kind: block.kind,
        title: block.title,
        defaultOpen: false,
        content: '[已遮罩]',
        ...(block.isError !== undefined ? { isError: block.isError } : {}),
        ...(block.toolName ? { toolName: block.toolName } : {}),
        ...(block.toolId ? { toolId: block.toolId } : {}),
        ...(block.durationMs !== undefined ? { durationMs: block.durationMs } : {}),
        ...(block.executionStatus ? { executionStatus: block.executionStatus } : {}),
        ...(attachments ? { attachments } : {}),
      };
    }
    const { raw: _raw, presentation: _presentation, toolMetadata: _toolMetadata, subagent, ...safe } = block;
    return {
      ...safe,
      ...(attachments ? { attachments } : {}),
      ...(subagent ? {
        subagent: {
          agentType: subagent.agentType,
          description: subagent.description,
          childSessionId: subagent.childSessionId,
          childRunId: subagent.childRunId,
          status: subagent.status,
          ...(subagent.model ? { model: subagent.model } : {}),
          ...(subagent.durationMs !== undefined ? { durationMs: subagent.durationMs } : {}),
          ...(subagent.totalTokens !== undefined ? { totalTokens: subagent.totalTokens } : {}),
          ...(subagent.toolUseCount !== undefined ? { toolUseCount: subagent.toolUseCount } : {}),
          ...(subagent.turnCount !== undefined ? { turnCount: subagent.turnCount } : {}),
        },
      } : {}),
    };
  });
}

export function createOrgQaRouter(deps: OrgQaRouterDeps): Router {
  const router = Router();
  const resolveTranscriptPath = deps.resolveTranscriptPath ?? findTranscriptPathBySessionId;

  const requireContentGrant = async (
    req: Request,
    res: Response,
    tenantId: string | undefined,
    scope: 'qa_read' | 'guardrail_read',
    targetType: 'session' | 'guardrail_collection',
    targetId: string,
  ): Promise<boolean> => {
    if (!req.user || !isPlatformAdmin(req.user)) return true;
    if (!tenantId || !deps.authorizeContentAccess) {
      res.status(403).json({ error: 'Content Access Grant required', code: 'CONTENT_ACCESS_GRANT_REQUIRED' });
      return false;
    }
    const allowed = await deps.authorizeContentAccess({
      tenantId, subjectUserId: req.user.sub, targetType, targetId, scope,
    });
    if (!allowed) {
      res.status(403).json({ error: 'Content Access Grant required', code: 'CONTENT_ACCESS_GRANT_REQUIRED' });
      return false;
    }
    return true;
  };

  router.use(async (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (req.user.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    if (deps.authorizeAdminAccess && !await deps.authorizeAdminAccess({
      userId: req.user.sub,
      tenantId: req.user.tenantId,
      platformAdmin: isPlatformAdmin(req.user),
    })) {
      res.status(403).json({ error: 'Active governance admin membership required' });
      return;
    }
    next();
  });

  // 1. 专职 Agent 会话列表（cursor 分页）
  router.get('/sessions', async (req, res) => {
    const parsed = listQaSessionsQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidQuery(res, parsed.error);
    const access = resolveTenant(req, parsed.data.tenantId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (!deps.sessionProjectionStore) {
      return res.status(503).json({ error: 'Runtime session projection store is not configured' });
    }

    try {
      const cursor = decodeCursor(parsed.data.cursor);
      const result = await deps.sessionProjectionStore.list({
        tenantId: access.tenantId,
        userId: parsed.data.userId,
        kind: 'user',
        ...(parsed.data.orgAgentId
          ? { orgAgentId: parsed.data.orgAgentId }
          : { hasOrgAgent: true }),
        updatedFrom: parsed.data.from,
        updatedTo: parsed.data.to,
        cursor: cursor ? { updatedAt: cursor.updatedAt, sessionId: cursor.id } : undefined,
        limit: parsed.data.limit ?? 50,
      });
      const items = result.items.map((record) => {
        const orgAgentId = typeof record.metaJson.orgAgentId === 'string' ? record.metaJson.orgAgentId : undefined;
        const orgAgent = orgAgentId ? deps.orgAgentStore?.get(orgAgentId) : undefined;
        return {
          sessionId: record.sessionId,
          title: record.title ?? null,
          userId: record.userId ?? null,
          username: record.username ?? null,
          orgAgentId: orgAgentId ?? null,
          orgAgentName: orgAgent?.name ?? null,
          orgAgentAvatar: orgAgent?.avatar ?? null,
          createdAt: record.createdAt ?? null,
          updatedAt: record.updatedAt,
          runtimeStatus: record.runtimeStatus ?? null,
          totalCostUsd: record.totalCostUsd ?? null,
        };
      });
      res.json({
        items,
        ...(result.nextCursor
          ? { nextCursor: encodeCursor({ updatedAt: result.nextCursor.updatedAt, id: result.nextCursor.sessionId }) }
          : {}),
      });
    } catch (err) {
      res.status(500).json({ error: `QA session list query failed: ${errorMessage(err)}` });
    }
  });

  // 2. 会话消息（组织管理权力：projection tenant 守卫 → transcript 解析，不走 canAccessSession）
  router.get('/sessions/:sessionId/messages', async (req, res) => {
    if (!deps.sessionProjectionStore) {
      return res.status(503).json({ error: 'Runtime session projection store is not configured' });
    }
    const sessionId = req.params.sessionId;
    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }
    const parsed = queryTenantSchema.safeParse(req.query);
    if (!parsed.success) return invalidQuery(res, parsed.error);
    const access = resolveTenant(req, parsed.data.tenantId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (!await requireContentGrant(req, res, access.tenantId, 'qa_read', 'session', sessionId)) return;
    try {
      const record = await deps.sessionProjectionStore.get(sessionId, { tenantId: access.tenantId, includeDeleted: true });
      if (!record) return res.status(404).json({ error: 'Session not found' });
      // 质检台只暴露专职 Agent 会话（与列表口径一致）；个人会话同 404 防探测（2026-07 审查 F3）
      if (!record.metaJson?.orgAgentId) return res.status(404).json({ error: 'Session not found' });

      const transcriptPath = await resolveTranscriptPath(sessionId);
      const parsed = transcriptPath
        ? await parseTranscriptFile(transcriptPath)
        : { sessionId, stats: { lines: 0, parsedLines: 0, parseErrors: 0 }, blocks: [] };

      const ownerRecord = record.userId ? deps.userStore?.findById(record.userId) : undefined;
      const owner = record.userId
        ? {
            userId: record.userId,
            username: record.username ?? ownerRecord?.username ?? record.userId,
            realName: ownerRecord?.realName,
            avatar: ownerRecord?.avatar,
            avatarVersion: ownerRecord?.avatarVersion,
          }
        : undefined;

      if (!deps.auditContentAccess) {
        return res.status(503).json({ error: 'Governance audit unavailable', code: 'GOVERNANCE_AUDIT_UNAVAILABLE' });
      }
      const auditId = await deps.auditContentAccess({
        tenantId: access.tenantId!,
        actorUserId: req.user!.sub,
        actorTenantId: req.user!.tenantId,
        actorPersona: isPlatformAdmin(req.user) ? 'platform_admin' : 'org_admin',
        sessionId,
        scope: 'qa_read',
      });
      auditLog(req, 'qa_session_opened', sessionId);
      res.json({
        sessionId: parsed.sessionId ?? sessionId,
        auditId,
        stats: parsed.stats,
        blocks: maskQaBlocks(parsed.blocks),
        ...(owner ? { owner } : {}),
      });
    } catch (err) {
      res.status(500).json({ error: `QA session messages query failed: ${errorMessage(err)}` });
    }
  });

  // 3. 门禁事件（offset 分页；store 需要明确 tenantId）
  router.get('/guardrail-events', async (req, res) => {
    const parsed = listGuardrailEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidQuery(res, parsed.error);
    const access = resolveTenant(req, parsed.data.tenantId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (!deps.guardrailEventStore) {
      return res.status(503).json({ error: 'Guardrail event store is not configured' });
    }
    if (!access.tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }
    if (!await requireContentGrant(
      req, res, access.tenantId, 'guardrail_read', 'guardrail_collection', access.tenantId,
    )) return;
    try {
      const result = await deps.guardrailEventStore.list({
        tenantId: access.tenantId,
        orgAgentId: parsed.data.orgAgentId,
        userId: parsed.data.userId,
        verdict: parsed.data.verdict,
        from: parsed.data.from,
        to: parsed.data.to,
        offset: parsed.data.offset,
        limit: parsed.data.limit,
      });
      res.json({
        ...result,
        events: result.events.map(({ messageText, ...event }) => ({
          ...event,
          messageDigest: messageText.startsWith('[redacted:sha256:')
            ? messageText.slice('[redacted:sha256:'.length, -1)
            : 'legacy-redacted',
        })),
      });
    } catch (err) {
      res.status(500).json({ error: `Guardrail event query failed: ${errorMessage(err)}` });
    }
  });

  // 4. 用户反馈（offset 分页）
  router.get('/feedback', async (req, res) => {
    const parsed = listFeedbackQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidQuery(res, parsed.error);
    const access = resolveTenant(req, parsed.data.tenantId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (!deps.messageFeedbackStore) {
      return res.status(503).json({ error: 'Message feedback store is not configured' });
    }
    if (!access.tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }
    if (!await requireContentGrant(
      req, res, access.tenantId, 'qa_read', 'guardrail_collection', access.tenantId,
    )) return;
    try {
      const result = await deps.messageFeedbackStore.listByTenant({
        tenantId: access.tenantId,
        orgAgentId: parsed.data.orgAgentId,
        userId: parsed.data.userId,
        from: parsed.data.from,
        to: parsed.data.to,
        offset: parsed.data.offset,
        limit: parsed.data.limit,
      });
      res.json({
        ...result,
        items: result.items.map(({ messageExcerpt: _messageExcerpt, ...item }) => item),
      });
    } catch (err) {
      res.status(500).json({ error: `Feedback query failed: ${errorMessage(err)}` });
    }
  });

  return router;
}

/** 平台 admin 可传 tenantId 任意过滤；组织 admin 强制自身租户，传别人的 403 */
function resolveTenant(
  req: Request,
  requestedTenantId?: string,
): { ok: true; tenantId?: string } | { ok: false; status: number; error: string } {
  if (!req.user) return { ok: false, status: 401, error: 'Authentication required' };
  if (isPlatformAdmin(req.user)) {
    if (!requestedTenantId) {
      return { ok: false, status: 400, error: '平台管理员必须显式指定 tenantId' };
    }
    return { ok: true, tenantId: requestedTenantId };
  }
  if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
    return { ok: false, status: 403, error: 'Tenant access denied' };
  }
  return { ok: true, tenantId: req.user.tenantId };
}

function invalidQuery(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: 'Invalid query', issues: error.issues });
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

function decodeCursor(value: string | undefined): CursorValue | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf-8')) as Partial<CursorValue>;
    if (!parsed.updatedAt || !parsed.id) return null;
    if (!Number.isFinite(Date.parse(parsed.updatedAt))) return null;
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
