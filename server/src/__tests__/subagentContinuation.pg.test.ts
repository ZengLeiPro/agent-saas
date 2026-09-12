import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgEventStore } from '../runtime/pgEventStore.js';
import { PgRunStore } from '../runtime/runStore.js';
import { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';
import {
  cleanupSteeringPgTest,
  describePg,
  testPgUrl,
} from './pgRunStoreSteering.pg.testHelpers.js';

const { Pool } = pg;

describePg('stable subagent continuation PostgreSQL contract', () => {
  const prefix = `subcont_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgRunStore;
  let eventStore: PgEventStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 8 });
    eventStore = new PgEventStore({
      connectionString: testPgUrl!,
      tablePrefix: prefix,
      poolMax: 4,
    });
    await eventStore.init();
    store = new PgRunStore({
      pool,
      tablePrefix: prefix,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });
    await store.init();
    await new PgToolInvocationStore({ pool, tablePrefix: prefix }).init();
  }, 30_000);

  afterAll(async () => {
    if (pool) await cleanupSteeringPgTest(pool, eventStore, prefix);
  }, 30_000);

  const reservation = (runId: string) =>
    store.reserveSubagentContinuation({
      runId,
      sessionId: 'child-session',
      userId: 'user-1',
      tenantId: 'tenant-1',
      model: 'provider/model-a',
      channel: 'web',
      idempotencyKey: runId,
      agentId: 'agent-stable',
      parentSessionId: 'parent-session',
      metadata: {
        subagent: true,
        subagentContinuationClaim: true,
        subagentAgentId: 'agent-stable',
        subagentContinuationProtocolVersion: 1,
        parentSessionId: 'parent-session',
        parentRunId: 'parent-run',
        agentType: 'explore',
        subagentMode: 'foreground',
        description: '续接测试',
        modelRef: 'group/model-a',
        subagentContinuation: { previousRunId: 'old-run', sequence: 1 },
      },
    });

  it('跨实例并发 idle resume 只保留一个 active child run', async () => {
    const results = await Promise.all([
      reservation('continuation-a'),
      reservation('continuation-b'),
    ]);
    const reserved = results.find((result) => result.state === 'reserved')!;
    const active = results.find((result) => result.state === 'active')!;
    expect(reserved).toBeTruthy();
    expect(active.record.runId).toBe(reserved.record.runId);

    const records = await store.listSubagentRunsByAgentId(
      'tenant-1',
      'parent-session',
      'agent-stable',
      { userId: 'user-1' },
    );
    expect(records.filter((record) => record.status === 'pending')).toHaveLength(1);
    await expect(
      store.listSubagentRunsByAgentId('tenant-2', 'parent-session', 'agent-stable', {
        userId: 'user-1',
      }),
    ).resolves.toEqual([]);
  });

  it('runner upsert 只对 continuation claim 更新最终 model 并移除 claim 标记', async () => {
    const current = (
      await store.listSubagentRunsByAgentId('tenant-1', 'parent-session', 'agent-stable', {
        userId: 'user-1',
      })
    )[0]!;
    const finalized = await store.upsertPending({
      runId: current.runId,
      sessionId: current.sessionId,
      userId: current.userId,
      tenantId: current.tenantId,
      model: 'provider/model-b',
      channel: current.channel,
      metadata: {
        subagent: true,
        subagentAgentId: 'agent-stable',
        subagentContinuationProtocolVersion: 1,
        parentSessionId: 'parent-session',
      },
    });
    expect(finalized.model).toBe('provider/model-b');
    expect(finalized.metadata.subagentContinuationClaim).toBeUndefined();
    await store.markStatus(current.runId, 'completed', 'done');
    await expect(reservation('continuation-c')).resolves.toMatchObject({
      state: 'reserved',
      record: { runId: 'continuation-c' },
    });
  });

  it('background continuation 的并发入队也只接受一个 wrapper', async () => {
    const enqueue = (runId: string) =>
      store.enqueueBackgroundTask(
        {
          runId,
          sessionId: 'parent-session',
          userId: 'user-1',
          tenantId: 'tenant-1',
          model: 'provider/model-a',
          channel: 'web',
          idempotencyKey: runId,
          metadata: {
            subagent: true,
            backgroundTask: true,
            subagentAgentId: 'agent-background',
            subagentContinuationProtocolVersion: 1,
            parentSessionId: 'parent-session',
            parentRunId: 'parent-run-background',
            subagentContinuation: { previousRunId: 'old-background-run', sequence: 1 },
          },
        },
        { perParentActive: 10, perTenantActive: 20 },
      );
    const results = await Promise.allSettled([
      enqueue('background-continuation-a'),
      enqueue('background-continuation-b'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain('SUBAGENT_CONTINUATION_ACTIVE:agent-background');
  });

  it('background physical child 创建前的补充消息可幂等排队并原子交接', async () => {
    const taskRunId = 'background-deferred-wrapper';
    const childRunId = 'background-deferred-child';
    await store.enqueueBackgroundTask(
      {
        runId: taskRunId,
        sessionId: 'parent-session',
        userId: 'user-1',
        tenantId: 'tenant-1',
        model: 'provider/model-a',
        channel: 'web',
        idempotencyKey: taskRunId,
        metadata: {
          subagent: true,
          backgroundTask: true,
          subagentAgentId: 'agent-deferred',
          subagentContinuationProtocolVersion: 1,
          parentSessionId: 'parent-session',
          parentRunId: 'parent-run-deferred',
        },
      },
      { perParentActive: 10, perTenantActive: 20 },
    );

    const firstMessage = {
      messageId: 'message-deferred-1',
      prompt: '先核对事实源',
      acceptedAt: '2026-09-12T08:00:00.000Z',
      senderId: 'user-1',
    };
    const secondMessage = {
      messageId: 'message-deferred-2',
      prompt: '补充输出验收表',
      acceptedAt: '2026-09-12T08:00:01.000Z',
      senderId: 'user-1',
    };
    const queued = await Promise.all([
      store.queueSubagentDeferredMessage({
        taskRunId,
        agentId: 'agent-deferred',
        tenantId: 'tenant-1',
        parentSessionId: 'parent-session',
        userId: 'user-1',
        message: firstMessage,
      }),
      store.queueSubagentDeferredMessage({
        taskRunId,
        agentId: 'agent-deferred',
        tenantId: 'tenant-1',
        parentSessionId: 'parent-session',
        userId: 'user-1',
        message: secondMessage,
      }),
      store.queueSubagentDeferredMessage({
        taskRunId,
        agentId: 'agent-deferred',
        tenantId: 'tenant-1',
        parentSessionId: 'parent-session',
        userId: 'user-1',
        message: firstMessage,
      }),
    ]);
    expect(queued).toEqual([{ state: 'accepted' }, { state: 'accepted' }, { state: 'accepted' }]);

    await store.upsertPending({
      runId: childRunId,
      sessionId: 'background-deferred-session',
      userId: 'user-1',
      tenantId: 'tenant-1',
      model: 'provider/model-a',
      channel: 'web',
      metadata: {
        subagent: true,
        subagentAgentId: 'agent-deferred',
        subagentContinuationProtocolVersion: 1,
        parentSessionId: 'parent-session',
        parentRunId: 'parent-run-deferred',
      },
    });
    await store.markStatus(taskRunId, 'running', 'background_child_created', {
      executionChildSessionId: 'background-deferred-session',
      executionChildRunId: childRunId,
    });

    const drained = await store.drainSubagentDeferredMessages({
      taskRunId,
      childRunId,
      agentId: 'agent-deferred',
      tenantId: 'tenant-1',
    });
    expect(drained.map((message) => message.messageId).sort()).toEqual([
      'message-deferred-1',
      'message-deferred-2',
    ]);
    await expect(
      store.drainSubagentDeferredMessages({
        taskRunId,
        childRunId,
        agentId: 'agent-deferred',
        tenantId: 'tenant-1',
      }),
    ).resolves.toEqual([]);
    const wrapper = await store.get(taskRunId);
    expect(wrapper?.metadata.subagentDeferredMessages).toBeUndefined();
    expect(wrapper?.metadata.subagentAppliedMessageIds).toEqual(
      expect.arrayContaining(['message-deferred-1', 'message-deferred-2']),
    );

    await expect(
      store.queueSubagentDeferredMessage({
        taskRunId,
        agentId: 'agent-deferred',
        tenantId: 'tenant-1',
        parentSessionId: 'parent-session',
        userId: 'user-1',
        message: { ...secondMessage, messageId: 'message-deferred-3' },
      }),
    ).resolves.toMatchObject({
      state: 'physical_active',
      target: { runId: childRunId },
    });
  });

  it('background 补充消息对跨租户、跨父会话、跨用户及终态 wrapper 均 fail closed', async () => {
    const taskRunId = 'background-deferred-auth-wrapper';
    const base = {
      taskRunId,
      agentId: 'agent-deferred-auth',
      tenantId: 'tenant-1',
      parentSessionId: 'parent-session',
      userId: 'user-1',
      message: {
        messageId: 'message-deferred-auth',
        prompt: '不能越权投递',
        acceptedAt: '2026-09-12T08:01:00.000Z',
      },
    };
    await store.enqueueBackgroundTask(
      {
        runId: taskRunId,
        sessionId: 'parent-session',
        userId: 'user-1',
        tenantId: 'tenant-1',
        model: 'provider/model-a',
        channel: 'web',
        idempotencyKey: taskRunId,
        metadata: {
          subagent: true,
          backgroundTask: true,
          subagentAgentId: 'agent-deferred-auth',
          subagentContinuationProtocolVersion: 1,
          parentSessionId: 'parent-session',
          parentRunId: 'parent-run-deferred-auth',
        },
      },
      { perParentActive: 10, perTenantActive: 20 },
    );

    for (const override of [
      { tenantId: 'tenant-2' },
      { parentSessionId: 'another-parent' },
      { userId: 'user-2' },
      { agentId: 'another-agent' },
    ]) {
      await expect(store.queueSubagentDeferredMessage({ ...base, ...override })).rejects.toThrow(
        'SUBAGENT_BACKGROUND_CONTINUATION_NOT_AUTHORIZED',
      );
    }
    await store.markStatus(taskRunId, 'completed', 'done');
    await expect(store.queueSubagentDeferredMessage(base)).rejects.toThrow(
      'SUBAGENT_BACKGROUND_CONTINUATION_NOT_AUTHORIZED',
    );
  });

  it('重启后的 store 仍能授权查询，并把非 web 子 run 的补充消息路由到准确目标', async () => {
    await store.upsertPending({
      runId: 'active-child-run',
      sessionId: 'active-child-session',
      userId: 'user-1',
      tenantId: 'tenant-1',
      model: 'provider/model-a',
      channel: 'dingtalk',
      metadata: {
        subagent: true,
        subagentAgentId: 'agent-active',
        subagentContinuationProtocolVersion: 1,
        parentSessionId: 'parent-session',
        parentRunId: 'parent-run',
        agentType: 'general',
        subagentMode: 'foreground',
        description: '运行中补充',
        modelRef: 'group/model-a',
      },
    });
    await store.markStatus('active-child-run', 'running', 'test');
    const restarted = new PgRunStore({
      pool,
      tablePrefix: prefix,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });
    await expect(
      restarted.listSubagentRunsByAgentId('tenant-1', 'parent-session', 'agent-active', {
        userId: 'user-1',
      }),
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ runId: 'active-child-run' })]),
    );

    const source = await restarted.enqueueUserMessage(
      {
        runId: 'active-resume-message',
        sessionId: 'active-child-session',
        userId: 'user-1',
        tenantId: 'tenant-1',
        model: 'provider/model-a',
        channel: 'dingtalk',
        idempotencyKey: 'active-resume-message',
        metadata: {
          subagent: true,
          subagentResumeMessage: true,
          subagentAgentId: 'agent-active',
          parentSessionId: 'parent-session',
          wakeMessage: { channel: 'dingtalk', chatId: 'active-child-session', content: '补充条件' },
        },
      },
      'steer',
    );
    expect(source.metadata.steeringTargetRunId).toBe('active-child-run');
    await expect(restarted.listPendingSteeringInputs('active-child-run')).resolves.toEqual([
      expect.objectContaining({
        sourceRunId: 'active-resume-message',
        targetRunId: 'active-child-run',
      }),
    ]);
  });

  it('稳定 agent_id 查询索引按租户、父会话和逻辑身份完整建立', async () => {
    const result = await pool.query<{ definition: string; predicate: string | null }>(
      `
      SELECT pg_get_indexdef(indexrelid) AS definition,
             pg_get_expr(indpred, indrelid) AS predicate
      FROM pg_index
      WHERE indexrelid = to_regclass($1)
        AND indisvalid
        AND indisready
        AND NOT indisunique
    `,
      [`${prefix}_runs_subagent_identity_idx`],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.definition).toContain(
      `(tenant_id, ((metadata ->> 'parentSessionId'::text)), ((metadata ->> 'subagentAgentId'::text)), requested_at DESC)`,
    );
    expect(result.rows[0]?.predicate).toContain(`metadata ->> 'subagent'::text`);
    expect(result.rows[0]?.predicate).toContain(`metadata ? 'subagentAgentId'::text`);

    const catalog = JSON.parse(
      readFileSync(
        new URL('../../../config/release-migration-postconditions.json', import.meta.url),
        'utf8',
      ),
    );
    const reviewed = catalog.entries.find(
      (entry: { path?: string }) => entry.path === 'server/src/runtime/runStoreSchema.ts',
    );
    expect(reviewed?.checks).toHaveLength(1);
    await expect(pool.query(reviewed.checks[0].sql, [prefix])).resolves.toMatchObject({
      rows: [{ ok: true }],
    });
  });
});
