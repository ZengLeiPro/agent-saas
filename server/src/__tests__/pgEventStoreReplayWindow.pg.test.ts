import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContextProjection } from '../runtime/contextProjection.js';
import { PgEventStore } from '../runtime/pgEventStore.js';
import type { PlatformEventInput } from '../runtime/types.js';

const connectionString =
  process.env.TEST_DATABASE_URL?.trim() || process.env.MEMORY_CONSOLIDATION_TEST_PG_URL?.trim();
const describePg = connectionString ? describe : describe.skip;
const prefix = `evt_replay_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const store = connectionString ? new PgEventStore({ connectionString, tablePrefix: prefix }) : null;
const TENANT = 'tenant-replay';
const SESSION = 'session-replay';
const excluded = ['tool_output_delta', 'tool_progress', 'assistant_stream_event'] as const;

describePg('PgEventStore checkpoint replay window', () => {
  beforeAll(async () => {
    await store!.init();
    await store!.appendBatch(
      [
        {
          id: 'start',
          type: 'run_started',
          runId: 'old',
          sessionId: SESSION,
          model: 'm',
          channel: 'web',
        },
        {
          id: 'old-user',
          type: 'user_message',
          runId: 'old',
          sessionId: SESSION,
          content: '历史目标',
        },
        {
          id: 'old-answer',
          type: 'assistant_message',
          runId: 'old',
          sessionId: SESSION,
          content: '历史回答',
        },
        {
          id: 'old-call',
          type: 'assistant_tool_calls',
          runId: 'old',
          sessionId: SESSION,
          content: '',
          toolCalls: [{ id: 'call-old', name: 'Read', arguments: '{}' }],
        },
        {
          id: 'old-result',
          type: 'tool_result',
          runId: 'old',
          sessionId: SESSION,
          toolCallId: 'call-old',
          toolName: 'Read',
          content: 'x'.repeat(120_000),
        },
        {
          id: 'tail-user',
          type: 'user_message',
          runId: 'active',
          sessionId: SESSION,
          content: '继续',
        },
        {
          id: 'tail-answer',
          type: 'assistant_message',
          runId: 'active',
          sessionId: SESSION,
          content: '继续执行',
        },
        {
          id: 'checkpoint',
          type: 'compaction',
          runId: 'active',
          sessionId: SESSION,
          summary: '历史已压缩',
          coveredEventCount: 5,
          cutoffEventId: 'tail-user',
          inline: true,
          checkpoint: {
            version: 1,
            trigger: 'threshold',
            sourceRunId: 'active',
            targetTokens: 10_000,
            summaryBudgetTokens: 1_000,
            summaryObservedTokens: 20,
            rawTailBudgetTokens: 5_000,
            rawTailObservedTokens: 20,
            fixedTokens: 200,
            taskAnchors: [
              {
                eventId: 'old-user',
                timestamp: '2026-09-04T00:00:00.000Z',
                text: '历史目标',
                originalChars: 4,
              },
            ],
          },
        },
      ] as PlatformEventInput[],
      { tenantId: TENANT },
    );
  });

  afterAll(async () => {
    if (!store) return;
    await store.pool.query(`DROP TABLE IF EXISTS ${prefix}_events`);
    await store.pool.query(`DROP TABLE IF EXISTS ${prefix}_event_cursors`);
    await store.close();
  });

  it('在 SQL 内省略 checkpoint 前非语义事件，投影与旧全量 replay 一致', async () => {
    const full = await store!.list(TENANT, SESSION, {
      excludeTypes: [...excluded],
      replayMode: 'bounded',
    });
    let stats;
    const events = await store!.list(TENANT, SESSION, {
      excludeTypes: [...excluded],
      replayMode: 'checkpoint',
      replayStats: (value) => {
        stats = value;
      },
    });

    expect(events.map((event) => event.id)).toEqual([
      'old-user',
      'tail-user',
      'tail-answer',
      'checkpoint',
    ]);
    expect(stats).toMatchObject({
      strategy: 'checkpoint',
      totalEventCount: 8,
      selectedEventCount: 4,
      checkpointEventId: 'checkpoint',
      cutoffSequence: 6,
      prefixEventCount: 1,
      tailEventCount: 3,
    });
    expect(stats!.totalStoredBytes).toBeGreaterThan(stats!.selectedStoredBytes!);
    expect(stats!.selectedStoredBytes).toBeGreaterThan(stats!.selectedProjectedBytes!);
    expect(buildContextProjection(events, { sessionId: SESSION, runId: 'next' }).messages).toEqual(
      buildContextProjection(full, { sessionId: SESSION, runId: 'next' }).messages,
    );
  });

  it('增量分页在 SQL 内截断新 tool_result，并从初始 cursor 后读取', async () => {
    let cursor: string | undefined;
    await store!.list(TENANT, SESSION, {
      replayMode: 'checkpoint',
      replayStats: (stats) => {
        cursor = stats.cursor;
      },
    });
    await store!.append(
      {
        id: 'new-result',
        type: 'tool_result',
        runId: 'active',
        sessionId: SESSION,
        toolCallId: 'call-new',
        toolName: 'Shell',
        content: 'y'.repeat(80_000),
      },
      { tenantId: TENANT },
    );

    const page = await store!.listPage(TENANT, SESSION, {
      afterCursor: cursor,
      limit: 10,
      replayMode: 'bounded',
    });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ id: 'new-result', type: 'tool_result' });
    expect(
      (page.events[0] as Extract<(typeof page.events)[number], { type: 'tool_result' }>).content
        .length,
    ).toBeLessThan(80_000);
  });
});
