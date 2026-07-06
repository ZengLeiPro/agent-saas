import { Router } from 'express';
import pg from 'pg';

import { requirePlatformAdmin } from '../auth/middleware.js';
import type { AppConfig } from '../app/config.js';
import { createTenantRemoteHandAuthTokenResolver } from '../runtime/tenantRemoteHandResolver.js';
import type { SecretVault } from '../security/secretVault.js';
import {
  probeTenantRemoteHandHealth,
  sanitizeTenantRemoteHands,
} from './tenantRemoteHandsAdmin.js';
import { parseWorkspaceId } from '../runtime/workspaceIdentity.js';

const { Client } = pg;

export interface CreateRuntimeOperationsAdminRouterOptions {
  config: AppConfig;
  secretVault?: SecretVault;
  fetchImpl?: typeof fetch;
  healthTimeoutMs?: number;
  processRole?: string;
}

type RuntimeEventStoreResponse =
  | Awaited<ReturnType<typeof queryRuntimePg>>
  | { backend: string; status: 'error'; error: string };

type TenantRemoteHand = NonNullable<AppConfig['tenantRemoteHands']>['hands'][number];

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}

function cutoffIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function routedHandExpression() {
  return `COALESCE(metadata->>'autoRoutedHandId', metadata->>'handId', '')`;
}

function findAcsHand(config: AppConfig): TenantRemoteHand | undefined {
  return config.tenantRemoteHands?.hands.find((hand) => hand.id === 'agent-saas-acs')
    ?? config.tenantRemoteHands?.hands.find((hand) => /acs/i.test(hand.id));
}

async function resolveHandToken(hand: TenantRemoteHand, vault: SecretVault | undefined): Promise<string> {
  const resolver = createTenantRemoteHandAuthTokenResolver({
    tenantRemoteHands: [hand],
    vault,
  });
  return (await resolver.resolveForRegister(hand)).authToken;
}

export async function requestAcsOrchestrator(args: {
  config: AppConfig;
  secretVault?: SecretVault;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  path: string;
  method: 'GET' | 'PATCH' | 'POST' | 'DELETE';
  body?: unknown;
}): Promise<{ status: number; body: unknown }> {
  const hand = findAcsHand(args.config);
  if (!hand) return { status: 404, body: { error: 'ACS hand not configured' } };
  const authToken = await resolveHandToken(hand, args.secretVault);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  timer.unref?.();
  try {
    const response = await args.fetchImpl(`${hand.baseUrl.replace(/\/$/, '')}${args.path}`, {
      method: args.method,
      headers: {
        authorization: `Bearer ${authToken}`,
        ...(args.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  } catch (error) {
    return {
      status: 502,
      body: {
        error: controller.signal.aborted
          ? `ACS orchestrator timeout (${args.timeoutMs}ms)`
          : error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

const ACS_SANDBOX_NAME_PATTERN = /^as-[a-z0-9-]{1,60}$/;

function validateAcsSandboxName(name: string): string | null {
  return ACS_SANDBOX_NAME_PATTERN.test(name) ? name : null;
}

function attachSandboxOwners(body: unknown): unknown {
  if (!body || typeof body !== 'object' || !('sandboxes' in body)) return body;
  const sandboxes = (body as { sandboxes?: unknown }).sandboxes;
  if (!Array.isArray(sandboxes)) return body;
  return {
    ...(body as Record<string, unknown>),
    sandboxes: sandboxes.map((sandbox) => attachSandboxOwner(sandbox)),
  };
}

function attachSandboxOwner(sandbox: unknown): unknown {
  if (!sandbox || typeof sandbox !== 'object') return sandbox;
  const record = sandbox as Record<string, unknown>;
  const workspaceId = typeof record.workspaceId === 'string' ? record.workspaceId : undefined;
  const parsed = parseWorkspaceId(workspaceId);
  return {
    ...record,
    owner: parsed
      ? { kind: 'user', tenantId: parsed.tenantId, userId: parsed.userId }
      : { kind: 'system', tenantId: null, userId: null },
  };
}

async function queryRuntimePg(config: AppConfig) {
  if (config.runtimeEventStore?.backend !== 'pg') {
    return {
      backend: config.runtimeEventStore?.backend ?? 'file',
      status: 'disabled' as const,
    };
  }

  const prefix = sanitizeIdentifier(config.runtimeEventStore.tablePrefix ?? 'runtime');
  const eventsTable = `${prefix}_events`;
  const runsTable = `${prefix}_runs`;
  const toolsTable = `${prefix}_tool_invocations`;
  const client = new Client({
    connectionString: config.runtimeEventStore.connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });
  const since1h = cutoffIso(1);
  const since24h = cutoffIso(24);
  await client.connect();
  try {
    const [
      handFailure1h,
      handFailure24h,
      activeRuns,
      activeRunDetails,
      staleActiveRuns,
      toolStatus24h,
      route24h,
      recentFailures,
      recentTools,
    ] = await Promise.all([
      client.query(
        `SELECT count(*)::int AS count
         FROM ${eventsTable}
         WHERE event_type='hand_failure' AND timestamp >= $1::timestamptz`,
        [since1h],
      ),
      client.query(
        `SELECT count(*)::int AS count, max(timestamp) AS latest_at
         FROM ${eventsTable}
         WHERE event_type='hand_failure' AND timestamp >= $1::timestamptz`,
        [since24h],
      ),
      client.query(
        `SELECT status, count(*)::int AS count, max(updated_at) AS latest_at
         FROM ${runsTable}
         WHERE status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
         GROUP BY status
         ORDER BY status`,
      ),
      client.query(
        `SELECT tenant_id, session_id, run_id, status, status_reason, model, channel,
                requested_at, started_at, updated_at, lease_expires_at, worker_id, workspace_id
         FROM ${runsTable}
         WHERE status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
         ORDER BY updated_at ASC
         LIMIT 20`,
      ),
      client.query(
        `SELECT tenant_id, session_id, run_id, status, status_reason, model, channel,
                requested_at, started_at, updated_at, lease_expires_at, worker_id, workspace_id
         FROM ${runsTable}
         WHERE status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
           AND updated_at < now() - interval '15 minutes'
         ORDER BY updated_at ASC
         LIMIT 20`,
      ),
      client.query(
        `SELECT status, count(*)::int AS count
         FROM ${toolsTable}
         WHERE started_at >= $1::timestamptz
         GROUP BY status
         ORDER BY status`,
        [since24h],
      ),
      client.query(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE ${routedHandExpression()} LIKE '%:agent-saas-acs')::int AS acs_count,
           count(*) FILTER (WHERE ${routedHandExpression()} LIKE '%:agent-saas-ecs')::int AS ecs_count,
           count(*) FILTER (WHERE ${routedHandExpression()} = '')::int AS unrouted_count
         FROM ${toolsTable}
         WHERE started_at >= $1::timestamptz`,
        [since24h],
      ),
      client.query(
        `SELECT timestamp, tenant_id, session_id, run_id,
                event_json->>'handId' AS hand_id,
                COALESCE(event_json->>'reason', event_json->>'message', event_json->>'error') AS reason
         FROM ${eventsTable}
         WHERE event_type='hand_failure'
         ORDER BY timestamp DESC
         LIMIT 8`,
      ),
      client.query(
        `SELECT started_at, tenant_id, session_id, run_id, tool_name, status,
                execution_target, ${routedHandExpression()} AS routed_hand
         FROM ${toolsTable}
         ORDER BY started_at DESC
         LIMIT 12`,
      ),
    ]);

    return {
      backend: 'pg' as const,
      status: 'ok' as const,
      tablePrefix: prefix,
      windows: { since1h, since24h },
      handFailures: {
        last1h: handFailure1h.rows[0]?.count ?? 0,
        last24h: handFailure24h.rows[0]?.count ?? 0,
        latestAt: handFailure24h.rows[0]?.latest_at ?? null,
        recent: recentFailures.rows,
      },
      activeRuns: activeRuns.rows,
      activeRunDetails: activeRunDetails.rows,
      staleActiveRuns: staleActiveRuns.rows,
      toolInvocations: {
        status24h: toolStatus24h.rows,
        route24h: route24h.rows[0] ?? { total: 0, acs_count: 0, ecs_count: 0, unrouted_count: 0 },
        recent: recentTools.rows,
      },
    };
  } finally {
    await client.end();
  }
}

export function createRuntimeOperationsAdminRouter(
  options: CreateRuntimeOperationsAdminRouterOptions,
): Router {
  const router = Router();
  const fetchImpl = options.fetchImpl ?? fetch;
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000;

  router.use(requirePlatformAdmin);

  router.get('/', async (_req, res) => {
    const safeHands = sanitizeTenantRemoteHands(options.config.tenantRemoteHands).hands;
    const handHealth = await Promise.all((options.config.tenantRemoteHands?.hands ?? []).map(async (hand) => ({
      id: hand.id,
      ...(await probeTenantRemoteHandHealth({
        hand,
        vault: options.secretVault,
        fetchImpl,
        timeoutMs: healthTimeoutMs,
      })),
    })));

    let runtimeEventStore: RuntimeEventStoreResponse;
    try {
      runtimeEventStore = await queryRuntimePg(options.config);
    } catch (error) {
      runtimeEventStore = {
        backend: options.config.runtimeEventStore?.backend ?? 'file',
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      } as const;
    }

    res.json({
      generatedAt: new Date().toISOString(),
      processRole: options.processRole ?? null,
      tenantRemoteHands: {
        hands: safeHands,
        health: handHealth,
      },
      runtimeEventStore,
    });
  });

  router.get('/acs/runtime-config', async (_req, res) => {
    const result = await requestAcsOrchestrator({
      config: options.config,
      secretVault: options.secretVault,
      fetchImpl,
      timeoutMs: healthTimeoutMs,
      path: '/runtime-config',
      method: 'GET',
    });
    res.status(result.status).json(result.body);
  });

  router.patch('/acs/runtime-config', async (req, res) => {
    const result = await requestAcsOrchestrator({
      config: options.config,
      secretVault: options.secretVault,
      fetchImpl,
      timeoutMs: healthTimeoutMs,
      path: '/runtime-config',
      method: 'PATCH',
      body: req.body,
    });
    res.status(result.status).json(result.body);
  });

  router.post('/acs/lifecycle-cleanup', async (_req, res) => {
    const result = await requestAcsOrchestrator({
      config: options.config,
      secretVault: options.secretVault,
      fetchImpl,
      timeoutMs: healthTimeoutMs,
      path: '/lifecycle/cleanup',
      method: 'POST',
      body: {},
    });
    res.status(result.status).json(result.body);
  });

  router.post('/acs/network-policy/probe', async (_req, res) => {
    const result = await requestAcsOrchestrator({
      config: options.config,
      secretVault: options.secretVault,
      fetchImpl,
      timeoutMs: Math.max(healthTimeoutMs, 90_000),
      path: '/network-policy/probe',
      method: 'POST',
      body: {},
    });
    res.status(result.status).json(result.body);
  });

  router.get('/acs/snat', async (_req, res) => {
    const result = await requestAcsOrchestrator({
      config: options.config,
      secretVault: options.secretVault,
      fetchImpl,
      timeoutMs: healthTimeoutMs,
      path: '/snat',
      method: 'GET',
    });
    res.status(result.status).json(result.body);
  });

  router.post('/acs/snat/cleanup-orphans', async (_req, res) => {
    const result = await requestAcsOrchestrator({
      config: options.config,
      secretVault: options.secretVault,
      fetchImpl,
      timeoutMs: Math.max(healthTimeoutMs, 30_000),
      path: '/snat/cleanup-orphans',
      method: 'POST',
      body: {},
    });
    res.status(result.status).json(result.body);
  });

  router.get('/acs/sandboxes', async (_req, res) => {
    const result = await requestAcsOrchestrator({
      config: options.config,
      secretVault: options.secretVault,
      fetchImpl,
      timeoutMs: healthTimeoutMs,
      path: '/sandboxes',
      method: 'GET',
    });
    res.status(result.status).json(attachSandboxOwners(result.body));
  });

  router.get('/acs/sandboxes/:name', async (req, res) => {
    const name = validateAcsSandboxName(req.params.name);
    if (!name) return res.status(400).json({ status: 'error', error: 'invalid sandbox name' });
    const result = await requestAcsOrchestrator({
      config: options.config,
      secretVault: options.secretVault,
      fetchImpl,
      timeoutMs: healthTimeoutMs,
      path: `/sandboxes/${encodeURIComponent(name)}`,
      method: 'GET',
    });
    res.status(result.status).json(result.body);
  });

  router.post('/acs/sandboxes/:name/pause', async (req, res) => {
    const name = validateAcsSandboxName(req.params.name);
    if (!name) return res.status(400).json({ status: 'error', error: 'invalid sandbox name' });
    const result = await requestAcsOrchestrator({
      config: options.config,
      secretVault: options.secretVault,
      fetchImpl,
      timeoutMs: healthTimeoutMs,
      path: `/sandboxes/${encodeURIComponent(name)}/pause`,
      method: 'POST',
      body: {},
    });
    res.status(result.status).json(result.body);
  });

  router.post('/acs/sandboxes/:name/resume', async (req, res) => {
    const name = validateAcsSandboxName(req.params.name);
    if (!name) return res.status(400).json({ status: 'error', error: 'invalid sandbox name' });
    const result = await requestAcsOrchestrator({
      config: options.config,
      secretVault: options.secretVault,
      fetchImpl,
      timeoutMs: Math.max(healthTimeoutMs, 90_000),
      path: `/sandboxes/${encodeURIComponent(name)}/resume`,
      method: 'POST',
      body: {},
    });
    res.status(result.status).json(result.body);
  });

  router.delete('/acs/sandboxes/:name', async (req, res) => {
    const name = validateAcsSandboxName(req.params.name);
    if (!name) return res.status(400).json({ status: 'error', error: 'invalid sandbox name' });
    const result = await requestAcsOrchestrator({
      config: options.config,
      secretVault: options.secretVault,
      fetchImpl,
      timeoutMs: Math.max(healthTimeoutMs, 30_000),
      path: `/sandboxes/${encodeURIComponent(name)}`,
      method: 'DELETE',
    });
    res.status(result.status).json(result.body);
  });

  return router;
}
