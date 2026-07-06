import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { AppConfig } from '../app/config.js';
import { isPlatformAdmin } from '../auth/types.js';
import type { JwtPayload } from '../auth/types.js';
import { USER_ID_PATTERN } from '../data/users/store.js';
import type { UserInfo } from '../data/users/types.js';
import type { UserStore } from '../data/users/store.js';
import type { TenantStore } from '../data/tenants/store.js';
import { TENANT_SLUG_PATTERN } from '../data/tenants/types.js';
import type { BillingService } from '../data/billing/service.js';
import { CREDIT_MICRO } from '../data/billing/types.js';
import { getSessionMetaProjectionStats } from '../data/transcripts/meta.js';
import type { SecretVault } from '../security/secretVault.js';
import type { DispatchMetricsSnapshot } from '../engine/metricsStore.js';
import type { PgRunStore, RunStatus } from '../runtime/runStore.js';
import type { PgEventStore } from '../runtime/pgEventStore.js';
import type { PgSessionProjectionStore, RuntimeSessionProjectionRecord } from '../runtime/sessionProjectionStore.js';
import type { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';
import { parseWorkspaceId } from '../runtime/workspaceIdentity.js';
import { requestAcsOrchestrator } from './runtimeOperationsAdmin.js';

const RUN_ID_RE = /^\d{13}-[0-9a-fA-F-]{36}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const SUB_SESSION_ID_RE = /^sub-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const SANDBOX_NAME_RE = /^as-[a-z0-9-]{1,60}$/;

const ACTIVE_RUN_STATUSES = ['pending', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand'] as const;
const RUN_STATUS_WHITELIST = new Set<RunStatus>([
  ...ACTIVE_RUN_STATUSES,
  'completed',
  'failed',
  'cancelled',
  'orphaned',
]);

const queryTenantSchema = z.object({
  tenantId: z.string().regex(TENANT_SLUG_PATTERN).optional(),
});

const searchQuerySchema = queryTenantSchema.extend({
  q: z.string().trim().min(1).max(200),
});

const listUsersQuerySchema = queryTenantSchema.extend({
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const listSessionsQuerySchema = queryTenantSchema.extend({
  userId: z.string().max(128).optional(),
  status: z.string().max(80).optional(),
  kind: z.enum(['user', 'subagent']).optional(),
  includeDeleted: z.coerce.boolean().optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const listRunsQuerySchema = queryTenantSchema.extend({
  userId: z.string().max(128).optional(),
  sessionId: z.string().max(128).optional(),
  status: z.string().max(300).optional(),
  hours: z.coerce.number().int().min(1).max(720).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export interface PlatformObservabilityRouterOptions {
  config: AppConfig;
  secretVault?: SecretVault;
  fetchImpl?: typeof fetch;
  acsTimeoutMs?: number;
  tenantStore?: TenantStore;
  userStore?: UserStore;
  billingService?: BillingService;
  runStore?: PgRunStore;
  sessionProjectionStore?: PgSessionProjectionStore;
  eventStore?: PgEventStore;
  toolInvocationStore?: PgToolInvocationStore;
  getDispatchMetrics?: () => DispatchMetricsSnapshot;
}

interface SearchMatch {
  kind: 'run' | 'session' | 'user' | 'tenant' | 'sandbox' | 'workspace';
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}

interface CursorValue {
  updatedAt: string;
  id: string;
}

interface SandboxSummary {
  name: string;
  workspaceId?: string;
  sandboxScopeId?: string;
  sessionId?: string;
  phase?: string;
  createdAt?: string;
  lastActiveAt?: string;
  image?: string;
  busy?: boolean;
  imageStale?: boolean;
  idleMs?: number;
  ttlRemainingMs?: number;
  effectiveTtlMs?: number;
  brokenReason?: string;
  owner?: { kind: 'user'; tenantId: string; userId: string } | { kind: 'system'; tenantId: null; userId: null };
  raw: Record<string, unknown>;
}

export function createPlatformObservabilityRouter(options: PlatformObservabilityRouterOptions): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (req.user.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  });

  router.get('/search', async (req, res) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidQuery(res, parsed.error);
    const access = resolveTenantForSearch(req, parsed.data.tenantId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.forceEmpty) return res.json({ matches: [] });

    try {
      const q = parsed.data.q;
      const matches: SearchMatch[] = [];
      await Promise.all([
        maybePushRunMatch(matches, options, q, access.tenantId),
        maybePushSessionMatch(matches, options, q, access.tenantId),
        maybePushUserMatch(matches, options, q, access.tenantId),
        maybePushWorkspaceMatches(matches, options, q, access.tenantId),
        maybePushSandboxMatch(matches, options, q, access.tenantId),
        maybePushFallbackMatches(matches, options, q, access.tenantId),
      ]);
      res.json({ matches: dedupeMatches(matches).slice(0, 30) });
    } catch (err) {
      res.status(500).json({ error: `Search failed: ${errorMessage(err)}` });
    }
  });

  router.get('/tenants/overview', async (req, res) => {
    const parsed = queryTenantSchema.safeParse(req.query);
    if (!parsed.success) return invalidQuery(res, parsed.error);
    const access = resolveTenant(req, parsed.data.tenantId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    try {
      const tenants = (options.tenantStore?.listAll() ?? [])
        .filter((tenant) => !access.tenantId || tenant.id === access.tenantId);
      const users = options.userStore?.listAll() ?? [];
      const [
        activeRuns,
        sessions7d,
        cost30d,
        balances,
        lastRunActivity,
        lastSessionActivity,
      ] = await Promise.all([
        queryTenantActiveRuns(options, access.tenantId),
        queryTenantSessions7d(options, access.tenantId),
        queryTenantCost30d(options, access.tenantId),
        queryTenantBalances(options, access.tenantId),
        queryTenantLastRunActivity(options, access.tenantId),
        queryTenantLastSessionActivity(options, access.tenantId),
      ]);
      const items = tenants.map((tenant) => {
        const tenantUsers = users.filter((user) => user.tenantId === tenant.id);
        const lastActiveAt = maxIso(lastRunActivity.get(tenant.id), lastSessionActivity.get(tenant.id));
        return {
          id: tenant.id,
          name: tenant.name,
          disabled: !!tenant.disabled,
          userCount: tenantUsers.length,
          adminCount: tenantUsers.filter((user) => user.role === 'admin').length,
          activeRuns: activeRuns.get(tenant.id) ?? 0,
          sessions7d: sessions7d.get(tenant.id) ?? 0,
          costYuan30d: cost30d.get(tenant.id) ?? 0,
          balanceCredits: balances.get(tenant.id) ?? null,
          lastActiveAt: lastActiveAt ?? null,
        };
      });
      res.json({ items, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: `Tenant overview query failed: ${errorMessage(err)}` });
    }
  });

  router.get('/users', async (req, res) => {
    const parsed = listUsersQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidQuery(res, parsed.error);
    const access = resolveTenant(req, parsed.data.tenantId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const limit = parsed.data.limit ?? 50;
    const cursor = decodeCursor(parsed.data.cursor);
    const q = parsed.data.q?.toLowerCase();
    let users = (options.userStore?.listAll() ?? [])
      .filter((user) => !access.tenantId || user.tenantId === access.tenantId)
      .filter((user) => !q || user.id.toLowerCase().includes(q)
        || user.username.toLowerCase().includes(q)
        || (user.realName ?? '').toLowerCase().includes(q));
    users = users.sort((a, b) => compareDesc(a.updatedAt, a.id, b.updatedAt, b.id));
    if (cursor) {
      users = users.filter((user) => compareDesc(user.updatedAt, user.id, cursor.updatedAt, cursor.id) > 0);
    }
    const page = users.slice(0, limit + 1);
    const items = page.slice(0, limit);
    const last = items[items.length - 1];
    res.json({
      items,
      ...(page.length > limit && last ? { nextCursor: encodeCursor({ updatedAt: last.updatedAt, id: last.id }) } : {}),
    });
  });

  router.get('/users/:id/summary', async (req, res) => {
    const user = options.userStore?.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!canAccessTenant(req.user!, user.tenantId)) return res.status(404).json({ error: 'User not found' });
    try {
      const [sessions, runs, costs, sandboxes] = await Promise.all([
        queryUserSessionSummary(options, user.tenantId, user.id),
        queryUserRunSummary(options, user.tenantId, user.id),
        queryUserCostSummary(options, user.tenantId, user.id),
        listSandboxes(options),
      ]);
      res.json({
        user: sanitizeUser(user),
        sessions30d: sessions.sessions30d,
        runs30d: runs,
        costYuan30d: costs.costYuan30d,
        costYuanTotal: costs.costYuanTotal,
        lastActiveAt: maxIso(sessions.lastActiveAt, runs.lastActiveAt, costs.lastActiveAt) ?? null,
        sandboxes: sandboxes.filter((sandbox) => sandbox.owner?.kind === 'user'
          && sandbox.owner.tenantId === user.tenantId
          && sandbox.owner.userId === user.id),
      });
    } catch (err) {
      res.status(500).json({ error: `User summary query failed: ${errorMessage(err)}` });
    }
  });

  router.get('/sessions', async (req, res) => {
    const parsed = listSessionsQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidQuery(res, parsed.error);
    const access = resolveTenant(req, parsed.data.tenantId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (!options.sessionProjectionStore) return res.status(503).json({ error: 'Runtime session projection store is not configured' });

    try {
      const cursor = decodeCursor(parsed.data.cursor);
      const result = await options.sessionProjectionStore.list({
        tenantId: access.tenantId,
        userId: parsed.data.userId,
        status: parsed.data.status,
        kind: parsed.data.kind ?? 'user',
        includeDeleted: parsed.data.includeDeleted ?? false,
        cursor: cursor ? { updatedAt: cursor.updatedAt, sessionId: cursor.id } : undefined,
        limit: parsed.data.limit ?? 50,
      });
      res.json({
        items: result.items.map(serializeSessionRecord),
        ...(result.nextCursor ? { nextCursor: encodeCursor({ updatedAt: result.nextCursor.updatedAt, id: result.nextCursor.sessionId }) } : {}),
      });
    } catch (err) {
      res.status(500).json({ error: `Session list query failed: ${errorMessage(err)}` });
    }
  });

  router.get('/sessions/:id', async (req, res) => {
    if (!options.sessionProjectionStore) return res.status(503).json({ error: 'Runtime session projection store is not configured' });
    const tenantId = isPlatformAdmin(req.user) ? undefined : req.user!.tenantId;
    try {
      const session = await options.sessionProjectionStore.get(req.params.id, { tenantId, includeDeleted: true });
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const [runs, billing, sandboxes] = await Promise.all([
        queryRunsBySession(options, session.sessionId, session.tenantId),
        options.billingService?.getSessionSummary(session.tenantId, session.sessionId).catch(() => null) ?? null,
        listSandboxes(options),
      ]);
      res.json({
        session: serializeSessionRecord(session),
        runs,
        billing,
        sandboxes: sandboxes.filter((sandbox) => sandbox.workspaceId && sandbox.workspaceId === session.workspaceId),
      });
    } catch (err) {
      res.status(500).json({ error: `Session detail query failed: ${errorMessage(err)}` });
    }
  });

  router.get('/runs', async (req, res) => {
    const parsed = listRunsQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidQuery(res, parsed.error);
    const access = resolveTenant(req, parsed.data.tenantId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (!options.runStore) return res.status(503).json({ error: 'Runtime run store is not configured' });
    const statuses = parseStatuses(parsed.data.status);
    if (!statuses.ok) return res.status(400).json({ error: statuses.error });
    try {
      const result = await queryRunsPage(options, {
        tenantId: access.tenantId,
        userId: parsed.data.userId,
        sessionId: parsed.data.sessionId,
        statuses: statuses.statuses,
        hours: parsed.data.hours ?? 24,
        cursor: decodeCursor(parsed.data.cursor),
        limit: parsed.data.limit ?? 50,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: `Run list query failed: ${errorMessage(err)}` });
    }
  });

  router.get('/overview/snapshot', async (req, res) => {
    if (!isPlatformAdmin(req.user)) {
      res.status(403).json({ error: 'Platform admin access required' });
      return;
    }
    try {
      const [runHealth, todayCostYuan, toolRouting24h, sandboxes, handFailures] = await Promise.all([
        queryRunHealth(options),
        queryTodayCostYuan(options),
        queryToolRouting24h(options),
        listSandboxes(options),
        queryHandFailures1h(options),
      ]);
      const attention = [
        ...await buildRunAttention(options),
        ...buildSandboxAttention(sandboxes),
        ...handFailures.map((item) => ({
          kind: 'hand_failure',
          severity: 'high',
          title: item.reason || 'hand_failure',
          entityRef: item.run_id ? { kind: 'run', id: item.run_id } : { kind: 'session', id: item.session_id ?? '' },
          occurredAt: toIsoOrNull(item.timestamp),
          actions: ['view_session'],
        })),
      ].slice(0, 50);

      res.json({
        generatedAt: new Date().toISOString(),
        health: {
          activeRuns: runHealth.activeRuns,
          sandboxes: summarizeSandboxes(sandboxes),
          todayCostYuan,
          todayRuns: runHealth.todayRuns,
          completionRate24h: runHealth.completionRate24h,
          toolRouting24h,
          dispatch: options.getDispatchMetrics?.() ?? null,
          sessionMetaProjection: getSessionMetaProjectionStats(),
          handFailures1h: handFailures.length,
        },
        attention,
      });
    } catch (err) {
      res.status(500).json({ error: `Overview snapshot query failed: ${errorMessage(err)}` });
    }
  });

  return router;
}

function resolveTenant(
  req: Request,
  requestedTenantId?: string,
): { ok: true; tenantId?: string } | { ok: false; status: number; error: string } {
  if (!req.user) return { ok: false, status: 401, error: 'Authentication required' };
  if (isPlatformAdmin(req.user)) return { ok: true, tenantId: requestedTenantId };
  if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
    return { ok: false, status: 403, error: 'Tenant access denied' };
  }
  return { ok: true, tenantId: req.user.tenantId };
}

function resolveTenantForSearch(
  req: Request,
  requestedTenantId?: string,
): { ok: true; tenantId?: string; forceEmpty?: boolean } | { ok: false; status: number; error: string } {
  if (!req.user) return { ok: false, status: 401, error: 'Authentication required' };
  if (isPlatformAdmin(req.user)) return { ok: true, tenantId: requestedTenantId };
  if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
    return { ok: true, tenantId: req.user.tenantId, forceEmpty: true };
  }
  return { ok: true, tenantId: req.user.tenantId };
}

function canAccessTenant(user: JwtPayload, tenantId: string | undefined): boolean {
  return isPlatformAdmin(user) || (!!tenantId && user.tenantId === tenantId);
}

async function maybePushRunMatch(
  matches: SearchMatch[],
  options: PlatformObservabilityRouterOptions,
  q: string,
  tenantId?: string,
): Promise<void> {
  if (!RUN_ID_RE.test(q) || !options.runStore) return;
  const params: unknown[] = [q];
  const clauses = ['run_id = $1'];
  if (tenantId) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  const result = await options.runStore.pool.query<{ run_id: string; session_id: string; tenant_id: string; status: string }>(
    `SELECT run_id, session_id, tenant_id, status
     FROM ${options.runStore.runsTable}
     WHERE ${clauses.join(' AND ')}
     LIMIT 1`,
    params,
  );
  const row = result.rows[0];
  if (!row) return;
  matches.push({
    kind: 'run',
    id: row.run_id,
    title: `Run ${row.run_id}`,
    subtitle: `${row.status} · ${row.tenant_id} · ${row.session_id}`,
    href: `/platform-admin/runs/${encodeURIComponent(row.run_id)}`,
  });
}

async function maybePushSessionMatch(
  matches: SearchMatch[],
  options: PlatformObservabilityRouterOptions,
  q: string,
  tenantId?: string,
): Promise<void> {
  if ((!UUID_RE.test(q) && !SUB_SESSION_ID_RE.test(q)) || !options.sessionProjectionStore) return;
  const session = await options.sessionProjectionStore.get(q, { tenantId, includeDeleted: true });
  if (!session) return;
  matches.push({
    kind: 'session',
    id: session.sessionId,
    title: session.title || session.sessionId,
    subtitle: `${session.tenantId}${session.userId ? ` · ${session.userId}` : ''}${session.deletedAt ? ' · deleted' : ''}`,
    href: `/platform-admin/sessions/${encodeURIComponent(session.sessionId)}`,
  });
}

async function maybePushUserMatch(
  matches: SearchMatch[],
  options: PlatformObservabilityRouterOptions,
  q: string,
  tenantId?: string,
): Promise<void> {
  if (!USER_ID_PATTERN.test(q) || !options.userStore) return;
  const user = options.userStore.findById(q);
  if (!user || (tenantId && user.tenantId !== tenantId)) return;
  matches.push(userMatch(user));
}

async function maybePushWorkspaceMatches(
  matches: SearchMatch[],
  options: PlatformObservabilityRouterOptions,
  q: string,
  tenantId?: string,
): Promise<void> {
  if (!q.startsWith('ws_')) return;
  const parsed = parseWorkspaceId(q);
  if (!parsed || (tenantId && parsed.tenantId !== tenantId)) return;
  const tenant = options.tenantStore?.findById(parsed.tenantId);
  if (tenant) matches.push(tenantMatch(tenant));
  const user = options.userStore?.findById(parsed.userId);
  if (user && user.tenantId === parsed.tenantId) matches.push(userMatch(user));
  matches.push({
    kind: 'workspace',
    id: q,
    title: q,
    subtitle: `${parsed.tenantId} · ${parsed.userId}`,
    href: `/platform-admin/sandboxes?workspaceId=${encodeURIComponent(q)}`,
  });
  const sandboxes = await listSandboxes(options);
  for (const sandbox of sandboxes.filter((item) => item.workspaceId === q)) {
    matches.push(sandboxMatch(sandbox));
  }
}

async function maybePushSandboxMatch(
  matches: SearchMatch[],
  options: PlatformObservabilityRouterOptions,
  q: string,
  tenantId?: string,
): Promise<void> {
  if (!SANDBOX_NAME_RE.test(q)) return;
  const sandboxes = await listSandboxes(options);
  const sandbox = sandboxes.find((item) => item.name === q);
  if (!sandbox) return;
  if (tenantId && sandbox.owner?.tenantId !== tenantId) return;
  matches.push(sandboxMatch(sandbox));
}

async function maybePushFallbackMatches(
  matches: SearchMatch[],
  options: PlatformObservabilityRouterOptions,
  q: string,
  tenantId?: string,
): Promise<void> {
  const needle = q.toLowerCase();
  for (const tenant of (options.tenantStore?.listAll() ?? [])) {
    if (tenantId && tenant.id !== tenantId) continue;
    if (tenant.id.toLowerCase().includes(needle) || tenant.name.toLowerCase().includes(needle)) {
      matches.push(tenantMatch(tenant));
    }
    if (matches.length >= 10) break;
  }
  let userCount = 0;
  for (const user of (options.userStore?.listAll() ?? [])) {
    if (tenantId && user.tenantId !== tenantId) continue;
    if (
      user.id.toLowerCase().includes(needle)
      || user.username.toLowerCase().includes(needle)
      || (user.realName ?? '').toLowerCase().includes(needle)
    ) {
      matches.push(userMatch(user));
      userCount++;
      if (userCount >= 10) break;
    }
  }
}

async function queryTenantActiveRuns(options: PlatformObservabilityRouterOptions, tenantId?: string): Promise<Map<string, number>> {
  if (!options.runStore) return new Map();
  const params: unknown[] = [ACTIVE_RUN_STATUSES];
  const clauses = ['status = ANY($1::text[])', `updated_at >= now() - interval '24 hours'`];
  if (tenantId) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  const result = await options.runStore.pool.query<{ tenant_id: string; count: string }>(
    `SELECT tenant_id, count(*)::text AS count
     FROM ${options.runStore.runsTable}
     WHERE ${clauses.join(' AND ')}
     GROUP BY tenant_id`,
    params,
  );
  return new Map(result.rows.map((row) => [row.tenant_id, Number(row.count)]));
}

async function queryTenantSessions7d(options: PlatformObservabilityRouterOptions, tenantId?: string): Promise<Map<string, number>> {
  if (!options.sessionProjectionStore) return new Map();
  const params: unknown[] = [];
  const clauses = [`updated_at >= now() - interval '7 days'`];
  if (tenantId) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  const result = await options.sessionProjectionStore.pool.query<{ tenant_id: string; count: string }>(
    `SELECT tenant_id, count(*)::text AS count
     FROM ${options.sessionProjectionStore.sessionsTable}
     WHERE ${clauses.join(' AND ')}
     GROUP BY tenant_id`,
    params,
  );
  return new Map(result.rows.map((row) => [row.tenant_id, Number(row.count)]));
}

async function queryTenantCost30d(options: PlatformObservabilityRouterOptions, tenantId?: string): Promise<Map<string, number>> {
  const store = options.billingService?.store;
  if (!store) return new Map();
  const params: unknown[] = [];
  const clauses = [`created_at >= now() - interval '30 days'`];
  if (tenantId) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  const result = await store.pool.query<{ tenant_id: string; cost: string }>(
    `SELECT tenant_id, COALESCE(sum(actual_cost_yuan_micro),0)::text AS cost
     FROM ${store.usageEventsTable}
     WHERE ${clauses.join(' AND ')}
     GROUP BY tenant_id`,
    params,
  );
  return new Map(result.rows.map((row) => [row.tenant_id, microToYuan(Number(row.cost))]));
}

async function queryTenantBalances(options: PlatformObservabilityRouterOptions, tenantId?: string): Promise<Map<string, number>> {
  const store = options.billingService?.store;
  if (!store) return new Map();
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (tenantId) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await store.pool.query<{ tenant_id: string; balance_micro: string }>(
    `SELECT tenant_id, balance_micro::text AS balance_micro
     FROM ${store.creditAccountsTable}
     ${where}`,
    params,
  );
  return new Map(result.rows.map((row) => [row.tenant_id, Number(row.balance_micro) / CREDIT_MICRO]));
}

async function queryTenantLastRunActivity(options: PlatformObservabilityRouterOptions, tenantId?: string): Promise<Map<string, string>> {
  if (!options.runStore) return new Map();
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (tenantId) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await options.runStore.pool.query<{ tenant_id: string; latest_at: Date | string | null }>(
    `SELECT tenant_id, max(updated_at) AS latest_at
     FROM ${options.runStore.runsTable}
     ${where}
     GROUP BY tenant_id`,
    params,
  );
  return new Map(result.rows.flatMap((row) => row.latest_at ? [[row.tenant_id, toIso(row.latest_at)]] : []));
}

async function queryTenantLastSessionActivity(options: PlatformObservabilityRouterOptions, tenantId?: string): Promise<Map<string, string>> {
  if (!options.sessionProjectionStore) return new Map();
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (tenantId) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await options.sessionProjectionStore.pool.query<{ tenant_id: string; latest_at: Date | string | null }>(
    `SELECT tenant_id, max(updated_at) AS latest_at
     FROM ${options.sessionProjectionStore.sessionsTable}
     ${where}
     GROUP BY tenant_id`,
    params,
  );
  return new Map(result.rows.flatMap((row) => row.latest_at ? [[row.tenant_id, toIso(row.latest_at)]] : []));
}

async function queryUserSessionSummary(
  options: PlatformObservabilityRouterOptions,
  tenantId: string,
  userId: string,
): Promise<{ sessions30d: number; lastActiveAt: string | null }> {
  if (!options.sessionProjectionStore) return { sessions30d: 0, lastActiveAt: null };
  const result = await options.sessionProjectionStore.pool.query<{ count: string; latest_at: Date | string | null }>(
    `SELECT count(*)::text AS count, max(updated_at) AS latest_at
     FROM ${options.sessionProjectionStore.sessionsTable}
     WHERE tenant_id = $1
       AND user_id = $2
       AND updated_at >= now() - interval '30 days'
       AND deleted_at IS NULL`,
    [tenantId, userId],
  );
  return {
    sessions30d: Number(result.rows[0]?.count ?? 0),
    lastActiveAt: toIsoOrNull(result.rows[0]?.latest_at),
  };
}

async function queryUserRunSummary(
  options: PlatformObservabilityRouterOptions,
  tenantId: string,
  userId: string,
): Promise<{ byStatus: Record<string, number>; total: number; lastActiveAt: string | null }> {
  if (!options.runStore) return { byStatus: {}, total: 0, lastActiveAt: null };
  const result = await options.runStore.pool.query<{ status: string; count: string; latest_at: Date | string | null }>(
    `SELECT status, count(*)::text AS count, max(updated_at) AS latest_at
     FROM ${options.runStore.runsTable}
     WHERE tenant_id = $1
       AND user_id = $2
       AND updated_at >= now() - interval '30 days'
     GROUP BY status`,
    [tenantId, userId],
  );
  const byStatus: Record<string, number> = {};
  let total = 0;
  let lastActiveAt: string | null = null;
  for (const row of result.rows) {
    const count = Number(row.count);
    byStatus[row.status] = count;
    total += count;
    lastActiveAt = maxIso(lastActiveAt ?? undefined, toIsoOrNull(row.latest_at) ?? undefined) ?? null;
  }
  return { byStatus, total, lastActiveAt };
}

async function queryUserCostSummary(
  options: PlatformObservabilityRouterOptions,
  tenantId: string,
  userId: string,
): Promise<{ costYuan30d: number; costYuanTotal: number; lastActiveAt: string | null }> {
  const store = options.billingService?.store;
  if (!store) return { costYuan30d: 0, costYuanTotal: 0, lastActiveAt: null };
  const result = await store.pool.query<{ cost_30d: string; cost_total: string; latest_at: Date | string | null }>(
    `SELECT
       COALESCE(sum(actual_cost_yuan_micro) FILTER (WHERE created_at >= now() - interval '30 days'),0)::text AS cost_30d,
       COALESCE(sum(actual_cost_yuan_micro),0)::text AS cost_total,
       max(created_at) AS latest_at
     FROM ${store.usageEventsTable}
     WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  return {
    costYuan30d: microToYuan(Number(result.rows[0]?.cost_30d ?? 0)),
    costYuanTotal: microToYuan(Number(result.rows[0]?.cost_total ?? 0)),
    lastActiveAt: toIsoOrNull(result.rows[0]?.latest_at),
  };
}

async function queryRunsBySession(
  options: PlatformObservabilityRouterOptions,
  sessionId: string,
  tenantId: string,
): Promise<Array<Record<string, unknown>>> {
  if (!options.runStore) return [];
  const result = await options.runStore.pool.query<{ row_json: Record<string, unknown> }>(
    `SELECT row_to_json(r.*) AS row_json
     FROM ${options.runStore.runsTable} r
     WHERE tenant_id = $1 AND session_id = $2
     ORDER BY updated_at DESC
     LIMIT 200`,
    [tenantId, sessionId],
  );
  return result.rows.map((row) => serializeRunRow(row.row_json));
}

async function queryRunsPage(
  options: PlatformObservabilityRouterOptions,
  query: {
    tenantId?: string;
    userId?: string;
    sessionId?: string;
    statuses?: RunStatus[];
    hours: number;
    cursor?: CursorValue | null;
    limit: number;
  },
): Promise<{ items: Array<Record<string, unknown>>; nextCursor?: string }> {
  const runStore = options.runStore!;
  const params: unknown[] = [];
  const clauses = [`updated_at >= now() - ($${pushParam(params, query.hours)}::int * interval '1 hour')`];
  if (query.tenantId) clauses.push(`tenant_id = $${pushParam(params, query.tenantId)}`);
  if (query.userId) clauses.push(`user_id = $${pushParam(params, query.userId)}`);
  if (query.sessionId) clauses.push(`session_id = $${pushParam(params, query.sessionId)}`);
  if (query.statuses?.length) clauses.push(`status = ANY($${pushParam(params, query.statuses)}::text[])`);
  if (query.cursor) {
    const updatedAtParam = pushParam(params, query.cursor.updatedAt);
    const idParam = pushParam(params, query.cursor.id);
    clauses.push(`(updated_at < $${updatedAtParam}::timestamptz OR (updated_at = $${updatedAtParam}::timestamptz AND run_id < $${idParam}))`);
  }
  const limitParam = pushParam(params, query.limit + 1);
  const result = await runStore.pool.query<{ row_json: Record<string, unknown> }>(
    `SELECT row_to_json(r.*) AS row_json
     FROM ${runStore.runsTable} r
     WHERE ${clauses.join(' AND ')}
     ORDER BY updated_at DESC, run_id DESC
     LIMIT $${limitParam}`,
    params,
  );
  const rows = result.rows.map((row) => serializeRunRow(row.row_json));
  const items = rows.slice(0, query.limit);
  const last = items[items.length - 1];
  return {
    items,
    ...(rows.length > query.limit && last
      ? { nextCursor: encodeCursor({ updatedAt: String(last.updatedAt), id: String(last.runId) }) }
      : {}),
  };
}

async function queryRunHealth(options: PlatformObservabilityRouterOptions): Promise<{
  activeRuns: { total: number; byStatus: Record<string, number> };
  todayRuns: number;
  completionRate24h: number | null;
}> {
  if (!options.runStore) return { activeRuns: { total: 0, byStatus: {} }, todayRuns: 0, completionRate24h: null };
  const [active, today, terminal24h] = await Promise.all([
    options.runStore.pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM ${options.runStore.runsTable}
       WHERE status = ANY($1::text[])
       GROUP BY status`,
      [ACTIVE_RUN_STATUSES],
    ),
    options.runStore.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${options.runStore.runsTable}
       WHERE requested_at >= date_trunc('day', now())`,
    ),
    options.runStore.pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM ${options.runStore.runsTable}
       WHERE updated_at >= now() - interval '24 hours'
         AND status IN ('completed','failed','cancelled')
       GROUP BY status`,
    ),
  ]);
  const byStatus: Record<string, number> = {};
  for (const row of active.rows) byStatus[row.status] = Number(row.count);
  const completed = Number(terminal24h.rows.find((row) => row.status === 'completed')?.count ?? 0);
  const terminalTotal = terminal24h.rows.reduce((sum, row) => sum + Number(row.count), 0);
  return {
    activeRuns: { total: Object.values(byStatus).reduce((sum, value) => sum + value, 0), byStatus },
    todayRuns: Number(today.rows[0]?.count ?? 0),
    completionRate24h: terminalTotal > 0 ? completed / terminalTotal : null,
  };
}

async function queryTodayCostYuan(options: PlatformObservabilityRouterOptions): Promise<number> {
  const store = options.billingService?.store;
  if (!store) return 0;
  const result = await store.pool.query<{ cost: string }>(
    `SELECT COALESCE(sum(actual_cost_yuan_micro),0)::text AS cost
     FROM ${store.usageEventsTable}
     WHERE created_at >= date_trunc('day', now())`,
  );
  return microToYuan(Number(result.rows[0]?.cost ?? 0));
}

async function queryToolRouting24h(options: PlatformObservabilityRouterOptions): Promise<Record<string, unknown> | null> {
  if (!options.toolInvocationStore || !options.runStore) return null;
  const table = options.toolInvocationStore.toolInvocationsTable;
  const result = await options.runStore.pool.query<Record<string, string>>(
    `SELECT
       count(*)::text AS total,
       count(*) FILTER (WHERE execution_target = 'acs')::text AS acs_count,
       count(*) FILTER (WHERE execution_target = 'server-local')::text AS local_count,
       count(*) FILTER (WHERE status = 'failed')::text AS failed_count
     FROM ${table}
     WHERE started_at >= now() - interval '24 hours'`,
  );
  const row = result.rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    acsCount: Number(row.acs_count ?? 0),
    localCount: Number(row.local_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
  };
}

async function buildRunAttention(options: PlatformObservabilityRouterOptions): Promise<Array<Record<string, unknown>>> {
  if (!options.runStore) return [];
  const [failed, stale] = await Promise.all([
    options.runStore.pool.query<Record<string, unknown>>(
      `SELECT run_id, session_id, tenant_id, user_id, status_reason, failed_at, updated_at
       FROM ${options.runStore.runsTable}
       WHERE status = 'failed'
         AND updated_at >= now() - interval '24 hours'
       ORDER BY updated_at DESC
       LIMIT 20`,
    ),
    options.runStore.pool.query<Record<string, unknown>>(
      `SELECT run_id, session_id, tenant_id, user_id, status, status_reason, updated_at
       FROM ${options.runStore.runsTable}
       WHERE status = ANY($1::text[])
         AND updated_at < now() - interval '15 minutes'
       ORDER BY updated_at ASC
       LIMIT 20`,
      [ACTIVE_RUN_STATUSES],
    ),
  ]);
  return [
    ...failed.rows.map((row) => ({
      kind: 'failed_run',
      severity: 'high',
      title: `Run failed: ${row.status_reason ?? row.run_id}`,
      entityRef: { kind: 'run', id: row.run_id },
      occurredAt: toIsoOrNull((row.failed_at ?? row.updated_at) as Date | string | null),
      actions: ['view_trace'],
    })),
    ...stale.rows.map((row) => ({
      kind: 'stale_run',
      severity: 'medium',
      title: `Stale ${row.status} run`,
      entityRef: { kind: 'run', id: row.run_id },
      occurredAt: toIsoOrNull(row.updated_at as Date | string | null),
      actions: ['view_trace'],
    })),
  ];
}

async function queryHandFailures1h(options: PlatformObservabilityRouterOptions): Promise<Array<Record<string, any>>> {
  if (!options.eventStore) return [];
  const result = await options.eventStore.pool.query<Record<string, any>>(
    `SELECT timestamp, tenant_id, session_id, run_id,
            COALESCE(event_json->>'reason', event_json->>'message', event_json->>'error') AS reason
     FROM ${options.eventStore.eventsTable}
     WHERE event_type = 'hand_failure'
       AND timestamp >= now() - interval '1 hour'
     ORDER BY timestamp DESC
     LIMIT 20`,
  );
  return result.rows;
}

function buildSandboxAttention(sandboxes: SandboxSummary[]): Array<Record<string, unknown>> {
  const now = Date.now();
  const attention: Array<Record<string, unknown>> = [];
  for (const sandbox of sandboxes) {
    if (sandbox.brokenReason) {
      attention.push({
        kind: 'broken_sandbox',
        severity: 'high',
        title: sandbox.brokenReason,
        entityRef: { kind: 'sandbox', id: sandbox.name },
        occurredAt: sandbox.lastActiveAt ?? sandbox.createdAt ?? null,
        actions: ['view_sandbox', 'delete_recreate'],
      });
    }
    const phase = String(sandbox.phase ?? '');
    const createdAtMs = sandbox.createdAt ? Date.parse(sandbox.createdAt) : NaN;
    if (phase && phase !== 'Running' && phase !== 'Paused' && Number.isFinite(createdAtMs) && now - createdAtMs > 5 * 60_000) {
      attention.push({
        kind: 'transient_sandbox',
        severity: 'medium',
        title: `Sandbox stuck in ${phase}`,
        entityRef: { kind: 'sandbox', id: sandbox.name },
        occurredAt: sandbox.createdAt ?? null,
        actions: ['view_sandbox', 'cleanup'],
      });
    }
  }
  return attention;
}

async function listSandboxes(options: PlatformObservabilityRouterOptions): Promise<SandboxSummary[]> {
  const result = await requestAcsOrchestrator({
    config: options.config,
    secretVault: options.secretVault,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.acsTimeoutMs ?? 5_000,
    path: '/sandboxes',
    method: 'GET',
  });
  if (result.status < 200 || result.status >= 300) return [];
  const body = result.body as { sandboxes?: unknown };
  if (!Array.isArray(body.sandboxes)) return [];
  return body.sandboxes
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => {
      const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId : undefined;
      const owner = parseWorkspaceId(workspaceId);
      return {
        name: typeof item.name === 'string' ? item.name : '',
        workspaceId,
        sandboxScopeId: typeof item.sandboxScopeId === 'string' ? item.sandboxScopeId : undefined,
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : undefined,
        phase: typeof item.phase === 'string' ? item.phase : undefined,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
        lastActiveAt: typeof item.lastActiveAt === 'string' ? item.lastActiveAt : undefined,
        image: typeof item.image === 'string' ? item.image : undefined,
        busy: typeof item.busy === 'boolean' ? item.busy : undefined,
        imageStale: typeof item.imageStale === 'boolean' ? item.imageStale : undefined,
        idleMs: typeof item.idleMs === 'number' ? item.idleMs : undefined,
        ttlRemainingMs: typeof item.ttlRemainingMs === 'number' ? item.ttlRemainingMs : undefined,
        effectiveTtlMs: typeof item.effectiveTtlMs === 'number' ? item.effectiveTtlMs : undefined,
        brokenReason: typeof item.brokenReason === 'string' ? item.brokenReason : undefined,
        owner: owner
          ? { kind: 'user' as const, tenantId: owner.tenantId, userId: owner.userId }
          : { kind: 'system' as const, tenantId: null, userId: null },
        raw: item,
      };
    })
    .filter((item) => item.name);
}

function summarizeSandboxes(sandboxes: SandboxSummary[]): Record<string, number> {
  return {
    total: sandboxes.length,
    running: sandboxes.filter((item) => item.phase === 'Running').length,
    paused: sandboxes.filter((item) => item.phase === 'Paused').length,
    broken: sandboxes.filter((item) => !!item.brokenReason).length,
  };
}

function parseStatuses(raw: string | undefined): { ok: true; statuses?: RunStatus[] } | { ok: false; error: string } {
  if (!raw) return { ok: true };
  if (raw === 'active') return { ok: true, statuses: [...ACTIVE_RUN_STATUSES] };
  const statuses = raw.split(',').map((status) => status.trim()).filter(Boolean);
  if (statuses.length === 0) return { ok: false, error: 'Invalid status: empty' };
  const invalid = statuses.find((status) => !RUN_STATUS_WHITELIST.has(status as RunStatus));
  if (invalid) return { ok: false, error: `Invalid status: ${invalid}` };
  return { ok: true, statuses: statuses as RunStatus[] };
}

function userMatch(user: UserInfo): SearchMatch {
  return {
    kind: 'user',
    id: user.id,
    title: user.realName ? `${user.realName} (${user.username})` : user.username,
    subtitle: `${user.tenantId} · ${user.role}`,
    href: `/platform-admin/users/${encodeURIComponent(user.id)}`,
  };
}

function tenantMatch(tenant: { id: string; name: string; disabled?: boolean }): SearchMatch {
  return {
    kind: 'tenant',
    id: tenant.id,
    title: tenant.name,
    subtitle: `${tenant.id}${tenant.disabled ? ' · disabled' : ''}`,
    href: `/platform-admin/tenants/${encodeURIComponent(tenant.id)}`,
  };
}

function sandboxMatch(sandbox: SandboxSummary): SearchMatch {
  return {
    kind: 'sandbox',
    id: sandbox.name,
    title: sandbox.name,
    subtitle: `${sandbox.phase ?? 'unknown'}${sandbox.workspaceId ? ` · ${sandbox.workspaceId}` : ''}`,
    href: `/platform-admin/sandboxes/${encodeURIComponent(sandbox.name)}`,
  };
}

function serializeSessionRecord(record: RuntimeSessionProjectionRecord): Record<string, unknown> {
  return {
    sessionId: record.sessionId,
    tenantId: record.tenantId,
    userId: record.userId ?? null,
    username: record.username ?? null,
    channel: record.channel ?? null,
    kind: record.kind,
    title: record.title ?? null,
    runtimeStatus: record.runtimeStatus ?? null,
    model: record.model ?? null,
    executionTarget: record.executionTarget ?? null,
    workspaceId: record.workspaceId ?? null,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt ?? null,
    totalCostUsd: record.totalCostUsd ?? null,
    meta: record.metaJson,
  };
}

function serializeRunRow(raw: Record<string, any>): Record<string, unknown> {
  return {
    runId: raw.run_id ?? raw.runId,
    sessionId: raw.session_id ?? raw.sessionId,
    tenantId: raw.tenant_id ?? raw.tenantId ?? null,
    userId: raw.user_id ?? raw.userId ?? null,
    status: raw.status,
    statusReason: raw.status_reason ?? raw.statusReason ?? null,
    model: raw.model ?? null,
    channel: raw.channel ?? null,
    requestedAt: toIsoOrNull(raw.requested_at ?? raw.requestedAt),
    startedAt: toIsoOrNull(raw.started_at ?? raw.startedAt),
    updatedAt: toIso(raw.updated_at ?? raw.updatedAt),
    completedAt: toIsoOrNull(raw.completed_at ?? raw.completedAt),
    failedAt: toIsoOrNull(raw.failed_at ?? raw.failedAt),
    cancelledAt: toIsoOrNull(raw.cancelled_at ?? raw.cancelledAt),
    workerId: raw.worker_id ?? raw.workerId ?? null,
    executionTarget: raw.execution_target ?? raw.executionTarget ?? null,
    workspaceId: raw.workspace_id ?? raw.workspaceId ?? null,
    sandboxScopeId: raw.sandbox_scope_id ?? raw.sandboxScopeId ?? null,
    cumulativeInputTokens: Number(raw.cumulative_input_tokens ?? raw.cumulativeInputTokens ?? 0),
  };
}

function sanitizeUser(user: UserInfo): UserInfo {
  return { ...user };
}

function dedupeMatches(matches: SearchMatch[]): SearchMatch[] {
  const seen = new Set<string>();
  const out: SearchMatch[] = [];
  for (const match of matches) {
    const key = `${match.kind}:${match.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match);
  }
  return out;
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

function compareDesc(aUpdatedAt: string, aId: string, bUpdatedAt: string, bId: string): number {
  const time = bUpdatedAt.localeCompare(aUpdatedAt);
  if (time !== 0) return time;
  return bId.localeCompare(aId);
}

function pushParam(params: unknown[], value: unknown): number {
  params.push(value);
  return params.length;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value instanceof Date ? value.toISOString() : value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function maxIso(...values: Array<string | undefined | null>): string | undefined {
  return values.filter((value): value is string => !!value).sort().at(-1);
}

function microToYuan(micro: number): number {
  return Number((micro / 1_000_000).toFixed(6));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
