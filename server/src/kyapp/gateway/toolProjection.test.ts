/**
 * WP3 Phase A：会话工具快照 + `AppCapabilityToolProvider` 的行为钉死（规范 §6.1）。
 *
 * 覆盖：
 * - 能力集 = 登记 manifest ∩ `/me.capabilities.enabled`；
 * - **同会话工具指纹逐字节稳定**（首跑 / 审批恢复 / 交互恢复三次 warmup 同一签名）；
 * - 失效仅三种：新会话、`installation.*`、`registeredDigest` 变化；
 * - fail-static：`/me` 失败保留上次快照；首个 run 就失败 → 本会话无 `app__` 工具；
 * - `risk` 分档与 `neverAutoApprove`。
 */
import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Manifest } from '@kaiyan/ky-app-contract';

import {
  AppToolSnapshotService,
  type AppSnapshotSource,
  type AppVisibleInstallation,
} from './snapshot.js';
import { AppCapabilityToolProvider } from './toolProvider.js';
import {
  isAppReadOnlyTool,
  requiresAppWriteConfirmation,
  resetAppCapabilityRiskRegistryForTest,
} from './toolRiskRegistry.js';

const GATEWAY_CONFIG = { enabled: true, maxToolsPerSession: 64 };
const SESSION = { sessionId: 'sess-1', tenantId: 'org-1', userId: 'u-1' };

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    contractVersion: 1,
    systemId: 'demo-erp',
    name: '演示 ERP',
    capabilities: [
      {
        id: 'order.search',
        name: '查订单',
        description: '按条件查询订单列表，返回订单号与金额。',
        riskLevel: 'read_only',
        approval: 'none',
        safeToRetry: true,
        inputSchema: {
          type: 'object',
          properties: { keyword: { type: 'string' } },
          additionalProperties: false,
        },
        outputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        id: 'order.create',
        name: '建订单',
        description: '创建一张新订单，确认后立即生效。',
        riskLevel: 'external_write',
        approval: 'required',
        safeToRetry: false,
        inputSchema: {
          type: 'object',
          properties: { amount: { type: 'integer' } },
          additionalProperties: false,
        },
        outputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    ...overrides,
  } as unknown as Manifest;
}

interface Harness {
  source: AppSnapshotSource;
  service: AppToolSnapshotService;
  provider: AppCapabilityToolProvider;
  counts: { list: number; manifest: number; me: number };
  state: {
    installations: AppVisibleInstallation[];
    enabled: string[] | null;
    listThrows: boolean;
  };
}

function makeHarness(): Harness {
  const counts = { list: 0, manifest: 0, me: 0 };
  const state = {
    installations: [
      {
        installationId: 'iid-1',
        systemId: 'demo-erp',
        baseUrl: 'https://erp.example.com',
        registeredDigest: 'a'.repeat(64),
      },
    ] as AppVisibleInstallation[],
    enabled: ['order.search', 'order.create'] as string[] | null,
    listThrows: false,
  };
  const source: AppSnapshotSource = {
    async listVisibleInstallations() {
      counts.list += 1;
      if (state.listThrows) throw new Error('pg down');
      return state.installations;
    },
    async readManifest() {
      counts.manifest += 1;
      return manifest();
    },
    async readEnabledCapabilities() {
      counts.me += 1;
      return state.enabled === null ? null : new Set(state.enabled);
    },
  };
  const service = new AppToolSnapshotService({ source, config: GATEWAY_CONFIG });
  const provider = new AppCapabilityToolProvider({ snapshots: service });
  return { source, service, provider, counts, state };
}

/** 复刻 `chatCompletionsAdapter.ts:76-80` 的工具签名，用来验指纹稳定。 */
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

function contextFor(sessionId: string) {
  return {
    channelContext: {} as never,
    workspace: { root: '/tmp', executionTarget: 'server-local' as const, sessionId },
  };
}

describe('AppToolSnapshotService', () => {
  beforeEach(() => resetAppCapabilityRiskRegistryForTest());

  it('能力集 = 登记 manifest ∩ /me.capabilities.enabled', async () => {
    const harness = makeHarness();
    harness.state.enabled = ['order.search'];
    const snapshot = await harness.service.get(SESSION);
    expect(snapshot.entries.map((entry) => entry.toolName)).toEqual([
      'app__demo_erp__order_search',
    ]);
    expect(snapshot.degraded).toBe(false);
  });

  it('后续 run 只读快照：不重复拉 /me，条目对象逐一相同', async () => {
    const harness = makeHarness();
    const first = await harness.service.get(SESSION);
    const second = await harness.service.get(SESSION);
    expect(second).toBe(first);
    expect(harness.counts.me).toBe(1);
    // 安装目录每个 run 都读一次（用于比对 digest），这是失效判定的唯一依据。
    expect(harness.counts.list).toBe(2);
  });

  it('registeredDigest 变化触发重建', async () => {
    const harness = makeHarness();
    const first = await harness.service.get(SESSION);
    harness.state.installations = [
      { ...harness.state.installations[0]!, registeredDigest: 'b'.repeat(64) },
    ];
    const second = await harness.service.get(SESSION);
    expect(second).not.toBe(first);
    expect(second.key).not.toBe(first.key);
    expect(harness.counts.me).toBe(2);
  });

  it('installation.* 事件使快照失效', async () => {
    const harness = makeHarness();
    const first = await harness.service.get(SESSION);
    harness.service.invalidateInstallation('iid-1');
    expect(harness.service.peek(SESSION.sessionId)).toBeUndefined();
    const second = await harness.service.get(SESSION);
    expect(second).not.toBe(first);
    expect(second.entries).toHaveLength(first.entries.length);
  });

  it('菜单/能力开关翻动不影响当前会话（digest 不变即不重建）', async () => {
    const harness = makeHarness();
    const first = await harness.service.get(SESSION);
    harness.state.enabled = [];
    const second = await harness.service.get(SESSION);
    expect(second).toBe(first);
    expect(second.entries).toHaveLength(2);
  });

  it('/me 失败：已有快照沿用（fail-static），绝不中途删工具', async () => {
    const harness = makeHarness();
    const first = await harness.service.get(SESSION);
    harness.state.enabled = null;
    harness.state.installations = [
      { ...harness.state.installations[0]!, registeredDigest: 'c'.repeat(64) },
    ];
    const second = await harness.service.get(SESSION);
    expect(second.entries.map((entry) => entry.toolName)).toEqual(
      first.entries.map((entry) => entry.toolName),
    );
    expect(second.degraded).toBe(false);
  });

  it('首个 run 就拿不到 /me：本会话无 app__ 工具并标记 degraded', async () => {
    const harness = makeHarness();
    harness.state.enabled = null;
    const snapshot = await harness.service.get(SESSION);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.degraded).toBe(true);
  });

  it('安装目录读取失败：首个 run 降级，后续 run 沿用既有快照', async () => {
    const harness = makeHarness();
    harness.state.listThrows = true;
    const degraded = await harness.service.get(SESSION);
    expect(degraded.degraded).toBe(true);

    const other = makeHarness();
    const good = await other.service.get(SESSION);
    other.state.listThrows = true;
    expect(await other.service.get(SESSION)).toBe(good);
  });

  it('工具数超过上限时按工具名字典序截断', async () => {
    const harness = makeHarness();
    const capped = new AppToolSnapshotService({
      source: harness.source,
      config: { enabled: true, maxToolsPerSession: 1 },
    });
    const snapshot = await capped.get(SESSION);
    expect(snapshot.entries.map((entry) => entry.toolName)).toEqual([
      'app__demo_erp__order_create',
    ]);
  });

  it('gateway.enabled=false 时不产生任何工具', async () => {
    const harness = makeHarness();
    const off = new AppToolSnapshotService({
      source: harness.source,
      config: { enabled: false, maxToolsPerSession: 64 },
    });
    expect((await off.get(SESSION)).entries).toEqual([]);
    expect(harness.counts.list).toBe(0);
  });
});

describe('AppCapabilityToolProvider', () => {
  beforeEach(() => resetAppCapabilityRiskRegistryForTest());

  it('warmup 后 list 按 sessionId 返回描述符；未知会话返回空', async () => {
    const harness = makeHarness();
    await harness.provider.warmup({ ...SESSION, runId: 'run-1' });
    const tools = harness.provider.list(contextFor(SESSION.sessionId));
    expect(tools.map((tool) => tool.name)).toEqual([
      'app__demo_erp__order_create',
      'app__demo_erp__order_search',
    ]);
    expect(harness.provider.list(contextFor('other-session'))).toEqual([]);
    expect(harness.provider.list(undefined)).toEqual([]);
  });

  it('risk 分档：read_only=safe，external_write=dangerous 且 neverAutoApprove', async () => {
    const harness = makeHarness();
    await harness.provider.warmup({ ...SESSION, runId: 'run-1' });
    const tools = harness.provider.list(contextFor(SESSION.sessionId));
    const read = tools.find((tool) => tool.name === 'app__demo_erp__order_search')!;
    const write = tools.find((tool) => tool.name === 'app__demo_erp__order_create')!;

    expect(read.risk).toBe('safe');
    expect(read.resolveCallPolicy).toBeUndefined();
    expect(write.risk).toBe('dangerous');
    expect(write.resolveCallPolicy?.({})).toEqual({ risk: 'dangerous', neverAutoApprove: true });

    // 描述符构造时登记风险档 → channel 授权判定查得到
    expect(isAppReadOnlyTool('app__demo_erp__order_search')).toBe(true);
    expect(requiresAppWriteConfirmation('app__demo_erp__order_create')).toBe(true);
  });

  it('inputSchema 原样透传给模型可见 parameters，且不含被禁的正则关键字', async () => {
    const harness = makeHarness();
    await harness.provider.warmup({ ...SESSION, runId: 'run-1' });
    const read = harness.provider
      .list(contextFor(SESSION.sessionId))
      .find((tool) => tool.name === 'app__demo_erp__order_search')!;
    expect(read.parametersJsonSchema).toEqual({
      type: 'object',
      properties: { keyword: { type: 'string' } },
      additionalProperties: false,
    });
    const serialized = JSON.stringify(read.parametersJsonSchema);
    expect(serialized).not.toContain('pattern');
    expect(serialized).not.toContain('format');
  });

  it('invoke 前缀守卫：非 app__ 工具返回 undefined 让 provider 链继续', async () => {
    const harness = makeHarness();
    await harness.provider.warmup({ ...SESSION, runId: 'run-1' });
    const result = await harness.provider.invoke(
      {
        toolId: 'Bash',
        toolName: 'Bash',
        input: {},
        authorization: { approved: true, source: 'policy_auto' },
      } as never,
      contextFor(SESSION.sessionId) as never,
    );
    expect(result).toBeUndefined();
  });

  it('warmup 缺 tenantId/userId 时不产生工具（后台任务缺租户上下文的兜底）', async () => {
    const harness = makeHarness();
    expect(await harness.provider.warmup({ sessionId: 'sess-x' })).toEqual([]);
    expect(harness.counts.list).toBe(0);
  });

  it('同会话连续三个 run（首跑 / 审批恢复 / 交互恢复）工具指纹逐字节相同', async () => {
    const harness = makeHarness();
    const signatures: string[] = [];
    for (const runId of ['run-1', 'run-2-approval-resume', 'run-3-interaction-resume']) {
      await harness.provider.warmup({ ...SESSION, runId });
      signatures.push(
        toolSignature(
          harness.provider.list(contextFor(SESSION.sessionId)).map((tool) => tool.name),
        ),
      );
    }
    expect(new Set(signatures).size).toBe(1);
    // 恢复路径不得重新拉 /me —— 拉一次就有工具面抖动的风险。
    expect(harness.counts.me).toBe(1);

    // 能力开关在会话中途翻动同样不改指纹（提示「将在新会话生效」）。
    harness.state.enabled = ['order.search'];
    await harness.provider.warmup({ ...SESSION, runId: 'run-4' });
    expect(
      toolSignature(harness.provider.list(contextFor(SESSION.sessionId)).map((t) => t.name)),
    ).toBe(signatures[0]);
  });
});
