import { describe, expect, it, vi } from 'vitest';

import { SandboxWarmupService } from '../runtime/sandboxWarmup.js';
import { createTenantRemoteHandAuthTokenResolver } from '../runtime/tenantRemoteHandResolver.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';
import type { TenantRemoteHandDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';

const AGENT_CWD = '/data/mount/agent';

function record(overrides: Partial<RuntimeSessionRecord> & { sandboxProfile?: 'daily' | 'coding' } = {}): RuntimeSessionRecord {
  return {
    sessionId: 'sess-1',
    userId: 'u-1',
    username: 'zenglei',
    tenantId: 'kaiyan',
    channel: 'web',
    cwd: '/data/mount/workspaces/kaiyan/u-1',
    transcriptPath: '/tmp/t.jsonl',
    workspaceId: 'ws-kaiyan-u1',
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    ...overrides,
  };
}

function acsHand(overrides: Partial<TenantRemoteHandDispatchConfig> = {}): TenantRemoteHandDispatchConfig {
  return {
    id: 'agent-saas-acs',
    baseUrl: 'http://127.0.0.1:3400',
    authToken: 'test-token',
    rollout: { mode: 'all' },
    ...overrides,
  };
}

function buildService(input: {
  record?: RuntimeSessionRecord | null;
  hands?: TenantRemoteHandDispatchConfig[];
  fetchImpl?: typeof fetch;
  throttleMs?: number;
  registeredHand?: { metadata: Record<string, unknown> } | null;
  withSessionAdmissionLock?: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
}) {
  const fetchImpl = input.fetchImpl ?? (vi.fn(async () => new Response('', { status: 202 })) as unknown as typeof fetch);
  const service = new SandboxWarmupService({
    agentCwd: AGENT_CWD,
    sessionCatalog: { get: async () => input.record ?? null },
    handStore: { get: async () => (input.registeredHand ?? null) as never },
    tenantRemoteHands: () => input.hands,
    tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => input.hands }),
    fetchImpl,
    ...(input.withSessionAdmissionLock ? { withSessionAdmissionLock: input.withSessionAdmissionLock } : {}),
    ...(input.throttleMs !== undefined ? { throttleMs: input.throttleMs } : {}),
  });
  return { service, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn> };
}

describe('SandboxWarmupService', () => {
  it('record 存在且 ACS hand 可用时 POST /warmup，携带与 dispatch 同源的 scope 推导', async () => {
    const { service, fetchImpl } = buildService({ record: record(), hands: [acsHand()] });
    const result = await service.fireForSessionAsync('sess-1');
    expect(result).toBe('fired');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3400/warmup');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer test-token');
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({
      workspaceId: 'ws-kaiyan-u1',
      sessionId: 'sess-1',
      // cwd=/data/mount/workspaces/kaiyan/u-1 相对 mountRoot=/data/mount → workspaces/kaiyan/u-1
      // per-session Sandbox（2026-08-10）：预热只对顶层会话触发，故组键＝自身 sessionId。
      // 这个值必须与 rawRuntimeRunDispatch 顶层路径算出的 scope 逐字相同，
      // 否则会预热到一个稍后根本不会被用到的 pod。
      sandboxScopeId: 'ws-kaiyan-u1__workspaces_kaiyan_u-1__s_sess-1',
      mountSubPath: 'workspaces/kaiyan/u-1',
      workload: { class: 'interactive' },
    });
  });

  it('maps shared taskboard `{kind}` to the stable ACS `{class}` wire descriptor', async () => {
    const { service, fetchImpl } = buildService({
      record: record({ sandboxWorkloadDescriptor: { kind: 'taskboard', taskKind: 'delivery', purpose: 'review' } }),
      hands: [acsHand()],
    });
    expect(await service.fireForSessionAsync('sess-1')).toBe('fired');
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse((init as { body: string }).body).workload).toEqual({
      class: 'taskboard', taskKind: 'delivery', purpose: 'review',
    });
  });

  it.each([
    ['daily', { cpu: '1', memoryMb: 2_048 }],
    ['coding', { cpu: '2', memoryMb: 4_096 }],
  ] as const)('%s profile warmup 携带对应资源覆盖', async (sandboxProfile, resources) => {
    const { service, fetchImpl } = buildService({
      record: record({ sandboxProfile }),
      hands: [acsHand()],
    });
    expect(await service.fireForSessionAsync('sess-1')).toBe('fired');
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body.resources).toEqual(resources);
  });

  it('已注册 Environment Template hand 的最终资源优先于 profile', async () => {
    const { service, fetchImpl } = buildService({
      record: record({ sandboxProfile: 'daily' }),
      hands: [acsHand()],
      registeredHand: { metadata: { recipe: { resources: { cpu: '4', memoryMb: 8192 } } } },
    });
    expect(await service.fireForSessionAsync('sess-1')).toBe('fired');
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse((init as { body: string }).body).resources).toEqual({ cpu: '4', memoryMb: 8192 });
  });

  it('旧 record 无 sandboxProfile 时不发送资源覆盖，保留 orchestrator 全局默认', async () => {
    const { service, fetchImpl } = buildService({ record: record(), hands: [acsHand()] });
    expect(await service.fireForSessionAsync('sess-1')).toBe('fired');
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body).not.toHaveProperty('resources');
  });

  it('record 不存在（全新会话）时跳过，绝不自行推导身份或 workspace 映射', async () => {
    const { service, fetchImpl } = buildService({ record: null, hands: [acsHand()] });
    expect(await service.fireForSessionAsync('sess-x')).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('与软删除共用 Session 锁并在锁内重读 tombstone', async () => {
    const active = record();
    const lockCalls: string[] = [];
    const withSessionAdmissionLock = async <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
      lockCalls.push(sessionId);
      active.deletedAt = '2026-09-02T00:00:00.000Z';
      return operation();
    };
    const { service, fetchImpl } = buildService({
      record: active,
      hands: [acsHand()],
      withSessionAdmissionLock,
    });

    expect(await service.fireForSessionAsync('sess-1')).toBe('skipped');
    expect(lockCalls).toEqual(['sess-1']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('软删除 record 跳过，绝不为 tombstone 重建 Sandbox', async () => {
    const { service, fetchImpl } = buildService({
      record: record({ deletedAt: '2026-09-02T00:00:00.000Z' }),
      hands: [acsHand()],
    });
    expect(await service.fireForSessionAsync('sess-1')).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('subagent 隐藏会话跳过', async () => {
    const { service, fetchImpl } = buildService({ record: record({ kind: 'subagent' }), hands: [acsHand()] });
    expect(await service.fireForSessionAsync('sess-1')).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('无 eligible ACS hand（未配置 / rollout 不匹配）时跳过', async () => {
    const none = buildService({ record: record(), hands: undefined });
    expect(await none.service.fireForSessionAsync('sess-1')).toBe('skipped');
    expect(none.fetchImpl).not.toHaveBeenCalled();

    const drained = buildService({ record: record(), hands: [acsHand({ rollout: { mode: 'drain' } })] });
    expect(await drained.service.fireForSessionAsync('sess-1')).toBe('skipped');
    expect(drained.fetchImpl).not.toHaveBeenCalled();
  });

  it('同 scope 节流窗口内第二次跳过', async () => {
    const { service, fetchImpl } = buildService({ record: record(), hands: [acsHand()], throttleMs: 60_000 });
    expect(await service.fireForSessionAsync('sess-1')).toBe('fired');
    expect(await service.fireForSessionAsync('sess-1')).toBe('skipped');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('orchestrator 非 202 响应记为 skipped，不抛异常', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'error' }), { status: 503 })) as unknown as typeof fetch;
    const { service } = buildService({ record: record(), hands: [acsHand()], fetchImpl });
    expect(await service.fireForSessionAsync('sess-1')).toBe('skipped');
  });

  it('fireForSession 是 fire-and-forget：fetch 抛错也不影响调用方', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const { service } = buildService({ record: record(), hands: [acsHand()], fetchImpl });
    expect(() => service.fireForSession('sess-1')).not.toThrow();
    // 给后台 promise 一个 tick 完成（异常应被内部捕获）
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
