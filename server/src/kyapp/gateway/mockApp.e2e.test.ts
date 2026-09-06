/**
 * WP3 Phase B DoD 第一条：**用 mock 定制项目跑通 read / write / unknown 三条链**。
 *
 * 与 `lcid.test.ts` 的分工：那里用假出站钉状态机分支，这里起**真的 HTTP 服务**，
 * 走**真的 `createKyAppOutbound`**（SSRF 校验 + host 白名单 + `redirect:'manual'` +
 * 超时），验证整条链在真实网络语义下成立：
 * - 幂等键 `X-KY-Idempotency-Key` 确实到达定制项目，且写能力只收到一次 POST；
 * - `dig` 不一致 → 409 `digest_mismatch`；
 * - `apr`/`aph` 缺失 → 403 `approval_required`；
 * - 执行记录 `(iid, cap, sub, lcid)` 唯一，超时后靠 `executions/{lcid}` 收敛；
 * - 响应体 > 6,000 字节 → `response_too_large`。
 *
 * mock 侧按规范 §4.3/§4.4 实现，故意**不**做加密验签（SAT 由本用例的 stub 签发器
 * 生成；验签是 WP1 契约包与 `ky-app doctor` 的职责，不是 Gateway 的）。
 */
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { aph as computeAph } from '@kaiyan/ky-app-contract';

import type { KyAppGatewayLimits } from '../config.js';
import { createKyAppOutbound } from '../outbound.js';
import { AppApprovalRegistry } from './approval.js';
import { createAppCapabilityInvoker } from './invoker.js';
import { AppLogicalCallRunner } from './lcid.js';
import { GatewayPolicy } from './policy.js';
import type { AppCapabilityEntry } from './snapshot.js';
import type { AuthorizedToolCall, ToolCallContext } from '../../agent/toolRuntime.js';

const DIGEST = 'a'.repeat(64);
const LIMITS: KyAppGatewayLimits = {
  perInstallationConcurrency: 8,
  perRunPerCapability: 20,
  perTenantPerMinute: 300,
  perTenantPerDay: 5_000,
  breakerFailureThreshold: 20,
  breakerCooldownMs: 300_000,
};
const GATEWAY_CONFIG = {
  logicalCallDeadlineMs: 20_000,
  executionPollIntervalMs: 50,
  maxResponseBytes: 6_000,
  approvalTtlMs: 600_000,
};

interface ExecutionRecord {
  status: 'in_progress' | 'done' | 'failed';
  inputHash: string;
  result?: unknown;
  error?: { code: string; message: string };
}

/** 本轮请求账本，供断言「写能力只收到一次 POST」这类事实。 */
interface MockLedger {
  posts: Array<{ capability: string; idempotencyKey?: string; dig?: string; apr?: string }>;
  executionQueries: string[];
}

function decodeStubSat(header: string | undefined): Record<string, string> {
  const raw = header?.replace(/^Bearer\s+/u, '') ?? '';
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** 按规范 §4.3/§4.4 的最小实现。 */
function startMockApp(ledger: MockLedger): Promise<{ server: Server; baseUrl: string }> {
  const executions = new Map<string, ExecutionRecord>();
  /** `order.slow` 的第一次 POST 故意不回，逼 Gateway 走 executions 轮询。 */
  let slowStarted = false;
  let flakyAttempts = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const claims = decodeStubSat(req.headers.authorization);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const executionMatch = /^\/ky\/v1\/capabilities\/([^/]+)\/executions\/([^/]+)$/u.exec(
      url.pathname,
    );
    if (executionMatch && req.method === 'GET') {
      const lcid = decodeURIComponent(executionMatch[2]!);
      ledger.executionQueries.push(lcid);
      const record = executions.get(lcid);
      if (!record) return send(200, { status: 'not_started' });
      if (record.status === 'done') return send(200, { status: 'done', result: record.result });
      if (record.status === 'failed') return send(200, { status: 'failed', error: record.error });
      // in_progress 两次之后落终态，模拟真实的异步写入。
      if (ledger.executionQueries.filter((item) => item === lcid).length >= 3) {
        record.status = 'done';
        record.result = { orderId: 'SLOW-1' };
        return send(200, { status: 'done', result: record.result });
      }
      return send(200, { status: record.status });
    }

    const capabilityMatch = /^\/ky\/v1\/capabilities\/([^/]+)$/u.exec(url.pathname);
    if (!capabilityMatch || req.method !== 'POST')
      return send(404, {
        ok: false,
        error: { code: 'not_found', retryable: false, message: 'x', requestId: 'r' },
      });
    const capability = decodeURIComponent(capabilityMatch[1]!);

    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const idempotencyKey = req.headers['x-ky-idempotency-key'] as string | undefined;
      ledger.posts.push({
        capability,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(claims.dig ? { dig: claims.dig } : {}),
        ...(claims.apr ? { apr: claims.apr } : {}),
      });
      const body = raw ? (JSON.parse(raw) as { input?: unknown }) : {};
      const input = body.input ?? {};

      // §4.3：先比 dig。
      if (claims.dig !== DIGEST) {
        return send(409, {
          ok: false,
          error: { code: 'digest_mismatch', retryable: false, message: 'dig', requestId: 'r' },
        });
      }
      // §4.3：幂等键必带且等于 claim lcid。
      if (!idempotencyKey || idempotencyKey !== claims.lcid) {
        return send(400, {
          ok: false,
          error: { code: 'invalid_input', retryable: false, message: 'idem', requestId: 'r' },
        });
      }

      if (capability === 'order.search') {
        return send(200, {
          ok: true,
          data: { rows: [{ id: 1 }], keyword: (input as { keyword?: string }).keyword },
        });
      }
      if (capability === 'order.flaky') {
        flakyAttempts += 1;
        if (flakyAttempts <= 2)
          return send(503, {
            ok: false,
            error: { code: 'maintenance', retryable: true, message: 'x', requestId: 'r' },
          });
        return send(200, { ok: true, data: { attempts: flakyAttempts } });
      }
      if (capability === 'order.huge') {
        return send(200, { ok: true, data: { note: '中'.repeat(3_000) } });
      }

      // 写能力：必须带 apr + aph（§4.3 确认绑定）。
      if (!claims.apr || !claims.aph) {
        return send(403, {
          ok: false,
          error: { code: 'approval_required', retryable: false, message: 'apr', requestId: 'r' },
        });
      }
      const expected = computeAph({ cap: capability, input });
      if (claims.aph !== expected) {
        return send(403, {
          ok: false,
          error: { code: 'approval_required', retryable: false, message: 'aph', requestId: 'r' },
        });
      }

      if (capability === 'order.create') {
        // 执行记录 (iid, cap, sub, lcid) 唯一：同 lcid 同输入 → 返回既有记录。
        const existing = executions.get(idempotencyKey);
        if (existing?.status === 'done') return send(200, { ok: true, data: existing.result });
        const result = { orderId: 'B-1' };
        executions.set(idempotencyKey, { status: 'done', inputHash: expected, result });
        return send(200, { ok: true, data: result });
      }
      if (capability === 'order.slow') {
        // 首个 POST 落库后**不回响应**：Gateway 会超时并去查执行记录。
        if (!slowStarted) {
          slowStarted = true;
          executions.set(idempotencyKey, { status: 'in_progress', inputHash: expected });
          return; // 故意不回
        }
        return send(200, { ok: true, data: { orderId: 'SLOW-1' } });
      }
      if (capability === 'order.lost') {
        // 永远不回，且**不留执行记录** —— 这是 outcome_unknown 的典型现场。
        return;
      }
      return send(404, {
        ok: false,
        error: { code: 'not_found', retryable: false, message: 'x', requestId: 'r' },
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('mock 定制项目端到端（DoD 三条链）', () => {
  let server: Server;
  let baseUrl: string;
  let ledger: MockLedger;

  beforeAll(async () => {
    ledger = { posts: [], executionQueries: [] };
    const started = await startMockApp(ledger);
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function entry(overrides: Partial<AppCapabilityEntry> = {}): AppCapabilityEntry {
    return {
      installationId: 'iid-1',
      systemId: 'demo_erp',
      systemName: '演示 ERP',
      capabilityId: 'order.search',
      toolName: 'app__demo_erp__order_search',
      capabilityName: '查订单',
      description: '查订单',
      riskLevel: 'read_only',
      safeToRetry: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      registeredDigest: DIGEST,
      baseUrl,
      ...overrides,
    };
  }

  function writeEntry(capabilityId: string): AppCapabilityEntry {
    return entry({
      capabilityId,
      toolName: `app__demo_erp__${capabilityId.replace('.', '_')}`,
      capabilityName: '写操作',
      riskLevel: 'external_write',
      safeToRetry: false,
      timeoutMs: 1_000,
    });
  }

  function makeInvoker(overrides: { digest?: string } = {}) {
    // 真出站：local 环境 + 显式允许 http 环回，其余四道闸门（SSRF/精确 host/
    // redirect:'manual'/超时）全部照常生效。
    const outbound = createKyAppOutbound({
      config: { environment: 'local', allowInsecureOutbound: true },
      timeoutMs: 1_500,
    });
    return createAppCapabilityInvoker({
      runner: new AppLogicalCallRunner({
        issuer: {
          async issue(request) {
            // stub 签发器：把 claims 原样 base64url 编码，mock 侧按结构校验。
            const token = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
            return { token, expiresAt: 0, kid: 'k', jti: 'j' };
          },
        },
        outbound,
        config: GATEWAY_CONFIG,
      }),
      policy: new GatewayPolicy({ limits: LIMITS }),
      approvals: new AppApprovalRegistry(),
      config: GATEWAY_CONFIG,
      async isTenantAdmin() {
        return false;
      },
      ...(overrides.digest ? {} : {}),
    });
  }

  const context = {
    channelContext: {
      channel: 'web',
      user: { id: 'u-1', username: 'alice', role: 'user', tenantId: 'org-1' },
    },
    workspace: { root: '/tmp', executionTarget: 'server-local', sessionId: 'sess-1' },
    runId: 'run-1',
  } as unknown as ToolCallContext;

  function call(toolId: string, input: unknown, approvalId?: string): AuthorizedToolCall {
    return {
      toolId,
      input,
      authorization: approvalId
        ? { approved: true, approvalId, source: 'human_approval' }
        : { approved: true, source: 'policy_auto' },
    };
  }

  it('read 链：一次 200 拿到结果，幂等键与 dig 都到达定制项目', async () => {
    const result = await makeInvoker().invoke({
      entry: entry(),
      call: call('app__demo_erp__order_search', { keyword: '张三' }),
      context,
    });
    expect(result.content).toContain('张三');
    const post = ledger.posts.at(-1)!;
    expect(post.capability).toBe('order.search');
    expect(post.dig).toBe(DIGEST);
    expect(post.idempotencyKey).toBeTruthy();
    expect(result.metadata).toMatchObject({ attempts: 1, outputBytes: expect.any(Number) });
  });

  it('read 链：503 两次后成功，共 3 次 attempt', async () => {
    const result = await makeInvoker().invoke({
      entry: entry({ capabilityId: 'order.flaky', toolName: 'app__demo_erp__order_flaky' }),
      call: call('app__demo_erp__order_flaky', {}),
      context,
    });
    expect(result.metadata).toMatchObject({ attempts: 3 });
    expect(result.content).toContain('"attempts": 3');
  }, 20_000);

  it('read 链：响应体超 6,000 字节 → 结果太多，请缩小范围', async () => {
    const result = await makeInvoker().invoke({
      entry: entry({ capabilityId: 'order.huge', toolName: 'app__demo_erp__order_huge' }),
      call: call('app__demo_erp__order_huge', {}),
      context,
    });
    expect(result.content).toContain('结果太多，请缩小范围');
    expect(result.metadata).toMatchObject({ errorCode: 'response_too_large' });
  });

  it('write 链：带 apr/aph 一次成功，且 mock 侧只收到一次 POST', async () => {
    const before = ledger.posts.filter((item) => item.capability === 'order.create').length;
    const result = await makeInvoker().invoke({
      entry: writeEntry('order.create'),
      call: call('app__demo_erp__order_create', { amount: 100 }, 'ap-1'),
      context,
    });
    expect(result.content).toContain('B-1');
    const posts = ledger.posts.filter((item) => item.capability === 'order.create');
    expect(posts).toHaveLength(before + 1);
    expect(posts.at(-1)!.apr).toBe('ap-1');
  });

  it('write 链：定制项目拒绝无审批的写（Gateway 侧已先拦一道）', async () => {
    const result = await makeInvoker().invoke({
      entry: writeEntry('order.create'),
      call: call('app__demo_erp__order_create', { amount: 100 }),
      context,
    });
    expect(result.content).toContain('这个操作需要你确认后才能执行');
  });

  it('write 链：dig 不一致 → 该系统正在更新，暂不可操作', async () => {
    const result = await makeInvoker().invoke({
      entry: { ...writeEntry('order.create'), registeredDigest: 'b'.repeat(64) },
      call: call('app__demo_erp__order_create', { amount: 1 }, 'ap-dig'),
      context,
    });
    expect(result.content).toContain('该系统正在更新，暂不可操作');
    expect(result.metadata).toMatchObject({ errorCode: 'digest_mismatch' });
  });

  it('unknown 链：写请求超时但已落执行记录 → 轮询收敛为成功，绝不重发 POST', async () => {
    const before = ledger.posts.filter((item) => item.capability === 'order.slow').length;
    const result = await makeInvoker().invoke({
      entry: writeEntry('order.slow'),
      call: call('app__demo_erp__order_slow', { amount: 7 }, 'ap-slow'),
      context,
    });
    expect(result.content).toContain('SLOW-1');
    expect(ledger.posts.filter((item) => item.capability === 'order.slow')).toHaveLength(
      before + 1,
    );
    expect(ledger.executionQueries.length).toBeGreaterThan(0);
  }, 30_000);

  it('unknown 链：超时且查不到执行记录 → 操作结果未确认，请在系统中核对', async () => {
    const result = await makeInvoker().invoke({
      entry: { ...writeEntry('order.lost'), timeoutMs: 500 },
      call: call('app__demo_erp__order_lost', { amount: 1 }, 'ap-lost'),
      context,
    });
    expect(result.content).toContain('操作结果未确认，请在系统中核对');
    expect(result.metadata).toMatchObject({ errorCode: 'outcome_unknown' });
    // **禁止把超时说成未执行**：文案里不能出现「未执行」「没有执行」。
    expect(result.content).not.toContain('未执行');
  }, 40_000);
});
