import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createMiddlewareRunDispatch } from '../engine/dispatch.js';
import { DispatchMetricsStore } from '../engine/metricsStore.js';
import type { AgentRunDispatch } from '../agent/types.js';
import type { OutboundEvent } from '../types/index.js';

async function collect(stream: AsyncGenerator<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('run dispatch lifecycle', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('enforces rate limiting by channel+sender', async () => {
    const processCwd = await mkdtemp(join(tmpdir(), 'dispatch-rate-limit-'));
    cleanupDirs.add(processCwd);

    const baseRun: AgentRunDispatch = async function* () {
      yield { type: 'done' };
    };

    const runDispatch = createMiddlewareRunDispatch(baseRun, {
      processCwd,
      observability: { enabled: false },
      dispatch: {
        rateLimit: {
          enabled: true,
          maxRequests: 1,
          windowMs: 60_000,
        },
      },
    });

    const message = {
      channel: 'web' as const,
      chatId: 'chat-1',
      content: 'hello',
      senderId: 'u-1',
    };
    const context = { channel: 'web' as const };

    const first = await collect(runDispatch(message, context));
    const second = await collect(runDispatch(message, context));

    expect(first.map((event) => event.type)).toEqual(['done']);
    expect(second).toHaveLength(1);
    expect(second[0].type).toBe('error');
    expect(second[0].error).toContain('请求过于频繁');
  });

  it('records dispatch metrics via metrics store reporter', async () => {
    const processCwd = await mkdtemp(join(tmpdir(), 'dispatch-metrics-'));
    cleanupDirs.add(processCwd);

    const baseRun: AgentRunDispatch = async function* () {
      yield { type: 'text_delta', content: 'hello' };
      yield { type: 'done' };
    };

    const metricsStore = new DispatchMetricsStore();
    const runDispatch = createMiddlewareRunDispatch(baseRun, {
      processCwd,
      observability: {
        enabled: true,
        logging: false,
        metrics: true,
      },
      dispatch: {},
      metricsReporter: metricsStore.report,
    });

    await collect(runDispatch(
      { channel: 'cron', chatId: 'job-1', content: 'run-now' },
      { channel: 'cron' },
    ));

    const snapshot = metricsStore.getSnapshot();
    expect(snapshot.totalRuns).toBe(1);
    expect(snapshot.totalErrors).toBe(0);
    expect(snapshot.byChannel.cron?.runs).toBe(1);
    expect(snapshot.lastRun?.eventCount).toBe(2);
  });

  it('writes redacted audit records when audit is enabled', async () => {
    const processCwd = await mkdtemp(join(tmpdir(), 'dispatch-audit-'));
    cleanupDirs.add(processCwd);

    const baseRun: AgentRunDispatch = async function* () {
      yield { type: 'text_delta', content: 'model output' };
      yield { type: 'done' };
    };

    const auditPath = './audit/dispatch.jsonl';
    const runDispatch = createMiddlewareRunDispatch(baseRun, {
      processCwd,
      observability: {
        enabled: true,
        logging: false,
        metrics: false,
        audit: {
          enabled: true,
          path: auditPath,
          redact: true,
        },
      },
      dispatch: {},
    });

    await collect(runDispatch(
      { channel: 'dingtalk', chatId: 'c-1', content: 'sensitive text' },
      { channel: 'dingtalk', resumeSessionId: 'session-1' },
    ));

    const file = await readFile(join(processCwd, auditPath), 'utf-8');
    const [line] = file.trim().split('\n');
    const record = JSON.parse(line) as any;

    expect(record.channel).toBe('dingtalk');
    expect(record.request.content).toBe('[redacted:14]');
    expect(record.request.resumeSessionId).toBe('[redacted:9]');
    expect(record.result.eventCount).toBe(2);
  });
});
