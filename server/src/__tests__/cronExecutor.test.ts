import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CronJob } from '../cron/types.js';

const runAgentMock = vi.fn();

import { executeJob } from '../cron/executor.js';

function createCronJob(message: string): CronJob {
  const now = Date.now();
  return {
    id: 'job-1',
    name: 'job-name',
    enabled: true,
    schedule: { kind: 'every', everyMs: 60_000, anchorMs: now },
    payload: { kind: 'agentTurn', message },
    createdAtMs: now,
    updatedAtMs: now,
    state: {},
  };
}

function createOwnedCronJob(message: string): CronJob {
  return {
    ...createCronJob(message),
    owner: 'u-wain',
    ownerName: 'wain_user',
  };
}

describe('cron executor', () => {
  beforeEach(() => {
    runAgentMock.mockReset();
  });

  it('completes normally for text-only output without retry', async () => {
    runAgentMock.mockImplementation((_message: any, _context: any, _options: any, hooks: any) => (async function* () {
      await hooks?.onSessionStart?.('session-1', '/tmp/session-1.jsonl');
      await hooks?.onResult?.({ subtype: 'success', numTurns: 1, resultText: 'text-only' });
      yield { type: 'text_delta', content: 'text-only-delta' };
      yield { type: 'done' };
    })());

    const result = await executeJob(createCronJob('run task'), {
      runAgent: (...args: any[]) => runAgentMock(...args),
      agentCwd: '/tmp',
      sharedDir: '/tmp/.shared',
      timezone: 'Asia/Shanghai',
    });

    expect(result.status).toBe('ok');
    expect(result.output).toBe('text-only');
    expect(result.sessionId).toBe('session-1');
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('returns error status when runner emits error event', async () => {
    runAgentMock.mockImplementation((_message: any, _context: any, _options: any, hooks: any) => (async function* () {
      await hooks?.onSessionStart?.('session-2', '/tmp/session-2.jsonl');
      yield { type: 'error', error: 'runner failed' };
    })());

    const result = await executeJob(createCronJob('run task'), {
      runAgent: (...args: any[]) => runAgentMock(...args),
      agentCwd: '/tmp',
      sharedDir: '/tmp/.shared',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('runner failed');
    expect(result.sessionId).toBe('session-2');
    expect(result.transcriptPath).toBe('/tmp/session-2.jsonl');
  });

  it('does not dispatch when the cron owner tenant is disabled', async () => {
    const result = await executeJob(createOwnedCronJob('run task'), {
      runAgent: (...args: any[]) => runAgentMock(...args),
      agentCwd: '/tmp',
      sharedDir: '/tmp/.shared',
      userStore: {
        findById: vi.fn(() => ({
          id: 'u-wain',
          username: 'wain_user',
          role: 'user' as const,
          tenantId: 'wain',
        })),
      },
      tenantStore: {
        findById: vi.fn(() => ({ id: 'wain', name: '唯恩', disabled: true })),
      } as any,
    });

    expect(result).toMatchObject({ status: 'error', output: '组织已被禁用' });
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});
