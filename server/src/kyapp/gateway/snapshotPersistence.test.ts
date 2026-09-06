/**
 * WP3 Phase B：会话工具快照的**跨进程**语义（总控 2026-09-06 拍板，偏差 3-A-05 → 3-B-01）。
 *
 * 生产是多进程拓扑（Web/API blue|green + 独立 runtime-worker@blue|green）：
 * 审批恢复走 Web 进程、后台任务走 worker 进程。进程内快照必然让恢复路径工具面漂移、
 * `prompt_cache_key` 失配，所以快照必须落 v43 表。这里用内存假 store 钉死语义，
 * 真表的 SQL 合约在 `snapshotStore.pg.test.ts`。
 *
 * 另钉死总控 3-A-06 的分场景决定：cron / 后台任务创建的新会话（无活跃登录会话）
 * **不投影任何 `app__` 工具**，走 fail-static 的「首次失败」路径。
 */
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { Manifest } from '@kaiyan/ky-app-contract';

import { KyAppSatDeniedError } from '../sat/issuer.js';
import {
  AppToolSnapshotService,
  type AppSnapshotSource,
  type AppVisibleInstallation,
} from './snapshot.js';
import { createKyAppSnapshotSource } from './snapshotSource.js';
import type { AppToolSnapshotStore, PersistedAppToolSnapshot } from './snapshotStore.js';

const GATEWAY_CONFIG = { enabled: true, maxToolsPerSession: 64 };
const SESSION = { sessionId: 'sess-1', tenantId: 'org-1', userId: 'u-1' };
const DIGEST = 'a'.repeat(64);

function manifest(): Manifest {
  return {
    contractVersion: 1,
    systemId: 'demo-erp',
    name: '演示 ERP',
    pathPrefixes: { user: ['/api/app/'], admin: ['/api/admin/'] },
    capabilities: [
      {
        id: 'order.search',
        name: '查订单',
        description: '按条件查询订单列表。',
        riskLevel: 'read_only',
        approval: 'none',
        safeToRetry: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  } as unknown as Manifest;
}

/** 两个「进程」共享的内存 store，语义与 `PgAppToolSnapshotStore` 一致（首个写入者获胜）。 */
function makeMemoryStore(): AppToolSnapshotStore & { rows: Map<string, PersistedAppToolSnapshot> } {
  const rows = new Map<string, PersistedAppToolSnapshot>();
  return {
    rows,
    async load(sessionId) {
      return rows.get(sessionId) ?? null;
    },
    async save(snapshot) {
      const existing = rows.get(snapshot.sessionId);
      // ON CONFLICT DO UPDATE ... WHERE snapshot_key <> EXCLUDED.snapshot_key
      if (existing && existing.key === snapshot.key) return existing;
      rows.set(snapshot.sessionId, snapshot);
      return snapshot;
    },
    async deleteByInstallation(installationId) {
      let deleted = 0;
      for (const [sessionId, row] of rows) {
        if (row.entries.some((entry) => entry.installationId === installationId)) {
          rows.delete(sessionId);
          deleted += 1;
        }
      }
      return deleted;
    },
    async deleteBySession(sessionId) {
      return rows.delete(sessionId) ? 1 : 0;
    },
  };
}

function makeSource(counts: { list: number; me: number }): AppSnapshotSource {
  const installations: AppVisibleInstallation[] = [
    {
      installationId: 'iid-1',
      systemId: 'demo-erp',
      baseUrl: 'https://erp.example.com',
      registeredDigest: DIGEST,
    },
  ];
  return {
    async listVisibleInstallations() {
      counts.list += 1;
      return installations;
    },
    async readManifest() {
      return manifest();
    },
    async readEnabledCapabilities() {
      counts.me += 1;
      return new Set(['order.search']);
    },
  };
}

/** 复刻 `chatCompletionsAdapter.ts:76-80` 的工具签名。 */
function toolSignature(names: readonly string[]): string {
  return createHash('sha256')
    .update(
      names
        .map((name) => `-:${name}:eager`)
        .sort()
        .join(','),
    )
    .digest('hex')
    .slice(0, 32);
}

describe('会话工具快照跨进程持久化', () => {
  it('进程 B 读回进程 A 冻结的工具面：不重拉 /me，指纹逐字节相同', async () => {
    const store = makeMemoryStore();
    const countsA = { list: 0, me: 0 };
    const countsB = { list: 0, me: 0 };
    const processA = new AppToolSnapshotService({
      source: makeSource(countsA),
      config: GATEWAY_CONFIG,
      store,
    });
    const processB = new AppToolSnapshotService({
      source: makeSource(countsB),
      config: GATEWAY_CONFIG,
      store,
    });

    const first = await processA.get(SESSION);
    const resumed = await processB.get(SESSION);

    expect(countsA.me).toBe(1);
    // 进程 B 只读安装目录比对 digest，绝不再拉一次 /me。
    expect(countsB.me).toBe(0);
    expect(countsB.list).toBe(1);
    expect(toolSignature(resumed.entries.map((entry) => entry.toolName))).toBe(
      toolSignature(first.entries.map((entry) => entry.toolName)),
    );
    expect(JSON.stringify(resumed.entries)).toBe(JSON.stringify(first.entries));
  });

  it('两个进程同时为同一会话建快照：首个写入者获胜，两边收敛到同一份', async () => {
    const store = makeMemoryStore();
    const processA = new AppToolSnapshotService({
      source: makeSource({ list: 0, me: 0 }),
      config: GATEWAY_CONFIG,
      store,
    });
    const processB = new AppToolSnapshotService({
      source: makeSource({ list: 0, me: 0 }),
      config: GATEWAY_CONFIG,
      store,
    });
    const [a, b] = await Promise.all([processA.get(SESSION), processB.get(SESSION)]);
    expect(JSON.stringify(a.entries)).toBe(JSON.stringify(b.entries));
    expect(store.rows.size).toBe(1);
  });

  it('installation.* 事件同时清进程内与落库快照', async () => {
    const store = makeMemoryStore();
    const service = new AppToolSnapshotService({
      source: makeSource({ list: 0, me: 0 }),
      config: GATEWAY_CONFIG,
      store,
    });
    await service.get(SESSION);
    expect(store.rows.size).toBe(1);
    service.invalidateInstallation('iid-1');
    await vi.waitFor(() => expect(store.rows.size).toBe(0));
    expect(service.peek(SESSION.sessionId)).toBeUndefined();
  });

  it('落库不可用不拖垮 run：退回进程内语义并记日志', async () => {
    const warnings: string[] = [];
    const broken: AppToolSnapshotStore = {
      async load() {
        throw new Error('pg down');
      },
      async save() {
        throw new Error('pg down');
      },
      async deleteByInstallation() {
        return 0;
      },
      async deleteBySession() {
        return 0;
      },
    };
    const service = new AppToolSnapshotService({
      source: makeSource({ list: 0, me: 0 }),
      config: GATEWAY_CONFIG,
      store: broken,
      logger: { warn: (message) => warnings.push(message) },
    });
    const snapshot = await service.get(SESSION);
    expect(snapshot.entries).toHaveLength(1);
    expect(warnings.some((line) => line.includes('读取会话工具快照失败'))).toBe(true);
    expect(warnings.some((line) => line.includes('写入会话工具快照失败'))).toBe(true);
  });
});

describe('3-A-06：无活跃登录会话（cron / 后台任务）不投影 app__ 工具', () => {
  function makeCronSource(input: { hasActiveLogin: boolean; warnings?: string[] }) {
    const issued: string[] = [];
    const source = createKyAppSnapshotSource({
      systems: {
        async listInstallationsForTenant() {
          return [
            {
              installationId: 'iid-1',
              systemId: 'demo-erp',
              baseUrl: 'https://erp.example.com',
              registeredDigest: DIGEST,
              status: 'enabled',
            },
          ] as never;
        },
        async getDefinition() {
          return { status: 'published' } as never;
        },
        async getVersion() {
          return { manifest: manifest() } as never;
        },
      },
      assignments: {
        async listEffectiveResourceIds() {
          return [{ resourceId: 'iid-1' }] as never;
        },
      },
      issuer: {
        async issue(request) {
          // WP2a 四道前置：`act=user` 必须有会话 epoch 绑定，
          // cron / 后台任务没有活跃登录 → 拒签。
          if (request.act === 'user' && !request.authBinding) {
            throw new KyAppSatDeniedError('无活跃登录会话', 'auth_epoch_invalid');
          }
          issued.push(request.act);
          return { token: 't', expiresAt: 0, kid: 'k', jti: 'j' };
        },
      },
      outbound: {
        async request() {
          return {
            status: 200,
            text: '{}',
            json: { capabilities: [{ id: 'order.search', enabled: true }] },
            retryAfterMs: null,
          };
        },
      },
      config: { gateway: GATEWAY_CONFIG } as never,
      async isTenantAdmin() {
        return false;
      },
      resolveAuthBinding: () => (input.hasActiveLogin ? { authEpoch: 1, generation: 1 } : null),
      ...(input.warnings
        ? { logger: { warn: (message: string) => input.warnings!.push(message) } }
        : {}),
    });
    return { source, issued };
  }

  it('会话首个 run 无活跃登录 → 本会话无 app__ 工具并标 degraded', async () => {
    const warnings: string[] = [];
    const { source } = makeCronSource({ hasActiveLogin: false, warnings });
    const service = new AppToolSnapshotService({
      source,
      config: GATEWAY_CONFIG,
      logger: { warn: (message) => warnings.push(message) },
    });
    const snapshot = await service.get({ ...SESSION, sessionId: 'sess-cron' });
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.degraded).toBe(true);
    expect(warnings.some((line) => line.includes('SAT 签发被拒'))).toBe(true);
  });

  it('会话首个 run 有活跃登录 → 现有 epoch 派生保留，正常投影', async () => {
    const { source, issued } = makeCronSource({ hasActiveLogin: true });
    const service = new AppToolSnapshotService({ source, config: GATEWAY_CONFIG });
    const snapshot = await service.get({ ...SESSION, sessionId: 'sess-live' });
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.entries.map((entry) => entry.toolName)).toEqual([
      'app__demo_erp__order_search',
    ]);
    expect(issued).toEqual(['user']);
  });
});
