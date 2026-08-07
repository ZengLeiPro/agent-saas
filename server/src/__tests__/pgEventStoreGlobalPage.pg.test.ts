/**
 * PgEventStore.listGlobalPage / listSessionRange 真 PG 合同
 * （2026-07-29 L2 记忆整合批次新增查询）。
 * 设置 MEMORY_CONSOLIDATION_TEST_PG_URL 启用，否则 skip。
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgEventStore } from '../runtime/pgEventStore.js';

const connectionString = process.env.MEMORY_CONSOLIDATION_TEST_PG_URL;
const describePg = connectionString ? describe : describe.skip;
const prefix = `evt_test_${randomUUID().replaceAll('-', '_').slice(0, 12)}`;
const store = connectionString
  ? new PgEventStore({ connectionString, tablePrefix: prefix })
  : null;

const SESSION = 'sess-global-page';

describePg('PgEventStore listGlobalPage/listSessionRange contract', () => {
  beforeAll(async () => {
    await store!.init();
    await store!.append({ type: 'run_started', runId: 'r1', sessionId: SESSION, model: 'm', channel: 'web' } as never, { tenantId: 't1' });
    await store!.append({ type: 'user_message', runId: 'r1', sessionId: SESSION, content: '你好' } as never, { tenantId: 't1' });
    await store!.append({ type: 'assistant_thinking', runId: 'r1', sessionId: SESSION, content: '思考', durationMs: 1 } as never, { tenantId: 't1' });
    await store!.append({ type: 'assistant_message', runId: 'r1', sessionId: SESSION, content: '回复' } as never, { tenantId: 't1' });
    await store!.append({ type: 'run_finished', runId: 'r1', sessionId: SESSION, subtype: 'success', numTurns: 1 } as never, { tenantId: 't1' });
  });

  afterAll(async () => {
    await store?.close();
  });

  it('listGlobalPage 只返回指定类型、带行级 envelope、按 global_sequence 升序', async () => {
    const page = await store!.listGlobalPage({ afterGlobalSequence: 0, types: ['run_started', 'run_finished'], limit: 100 });
    const mine = page.events.filter((e) => e.sessionId === SESSION);
    expect(mine.map((e) => e.event.type)).toEqual(['run_started', 'run_finished']);
    expect(mine[0]!.tenantId).toBe('t1');
    expect(mine[0]!.globalSequence).toBeGreaterThan(0);
    expect(mine[1]!.globalSequence).toBeGreaterThan(mine[0]!.globalSequence);
    expect(mine[1]!.sessionSequence).toBe(5);
  });

  it('listGlobalPage 游标翻页：afterGlobalSequence 之后才返回', async () => {
    const first = await store!.listGlobalPage({ afterGlobalSequence: 0, types: ['run_started'], limit: 100 });
    const cursor = first.events.at(-1)!.globalSequence;
    const next = await store!.listGlobalPage({ afterGlobalSequence: cursor, types: ['run_started'], limit: 100 });
    expect(next.events.every((e) => e.globalSequence > cursor)).toBe(true);
  });

  it('listSessionRange 返回精确 sessionSequence 并按 excludeTypes 过滤', async () => {
    const rows = await store!.listSessionRange(SESSION, {
      fromExclusive: 0,
      toInclusive: 5,
      excludeTypes: ['assistant_thinking'],
    });
    expect(rows.map((r) => r.event.type)).toEqual(['run_started', 'user_message', 'assistant_message', 'run_finished']);
    expect(rows.map((r) => r.sessionSequence)).toEqual([1, 2, 4, 5]);
  });

  it('listSessionRange 半开区间 (from, to]', async () => {
    const rows = await store!.listSessionRange(SESSION, { fromExclusive: 2, toInclusive: 4 });
    expect(rows.map((r) => r.sessionSequence)).toEqual([3, 4]);
  });

  it('context_rewind 与隐藏恢复输入以同一 appendBatch 连续追加且原事件不变', async () => {
    const before = await store!.list(SESSION);
    const appended = await store!.appendBatch([
      {
        type: 'context_rewind',
        runId: 'r-recovery',
        sessionId: SESSION,
        reason: 'invalid_prompt_request_blocked',
        message: '自动回退上一工具交互并继续',
        sourceModelRequestId: 'request-1',
        sourceAttemptId: 'attempt-1',
        excludedEventIds: [before[2]!.id, before[3]!.id],
        excludedToolCallIds: ['call-1'],
        excludedStartSequence: 3,
        excludedEndSequence: 4,
        createdAt: '2026-08-07T01:00:00.000Z',
        recoveryAttempt: 1,
      },
      {
        type: 'user_message',
        runId: 'r-recovery',
        sessionId: SESSION,
        content: '继续',
        modelContent: '继续',
        systemGenerated: true,
        recoveryKind: 'invalid_prompt_rewind',
        hiddenFromUserTranscript: true,
      },
    ], { tenantId: 't1' });
    const after = await store!.list(SESSION);

    expect(after.slice(0, before.length)).toEqual(before);
    expect(appended.map((event) => event.type)).toEqual(['context_rewind', 'user_message']);
    expect((appended[0] as unknown as { sequence: number }).sequence + 1)
      .toBe((appended[1] as unknown as { sequence: number }).sequence);
  });
});
