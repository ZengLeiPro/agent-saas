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

  it('resolves the default model ref before dispatching a cron agent turn', async () => {
    runAgentMock.mockImplementation((_message: any, _context: any, _options: any, hooks: any) => (async function* () {
      await hooks?.onSessionStart?.('session-default-model', '/tmp/session-default-model.jsonl');
      await hooks?.onResult?.({ subtype: 'success', numTurns: 1, resultText: 'ok' });
      yield { type: 'done' };
    })());

    const resolveModel = vi.fn(() => ({
      model: 'glm-5.2',
      connection: { apiKey: 'sk-default', baseUrl: 'https://models.example/v1' },
      providerOptions: { protocol: 'responses' as const },
    }));

    const result = await executeJob(createCronJob('run task'), {
      runAgent: (...args: any[]) => runAgentMock(...args),
      agentCwd: '/tmp',
      sharedDir: '/tmp/.shared',
      defaultModel: 'kaiyan-llm/glm-5.2',
      resolveModel,
    });

    expect(result.status).toBe('ok');
    expect(result.modelRef).toBe('kaiyan-llm/glm-5.2');
    expect(resolveModel).toHaveBeenCalledWith('kaiyan-llm/glm-5.2', undefined);
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        model: 'glm-5.2',
        modelRef: 'kaiyan-llm/glm-5.2',
        modelConnection: { apiKey: 'sk-default', baseUrl: 'https://models.example/v1' },
        modelProviderOptions: { protocol: 'responses' },
      }),
      expect.anything(),
    );
  });

  it('uses the owner tenant when resolving the implicit default model', async () => {
    runAgentMock.mockImplementation((_message: any, _context: any, _options: any, hooks: any) => (async function* () {
      await hooks?.onSessionStart?.('session-tenant-default', '/tmp/session-tenant-default.jsonl');
      await hooks?.onResult?.({ subtype: 'success', numTurns: 1, resultText: 'ok' });
      yield { type: 'done' };
    })());

    const resolveDefaultModel = vi.fn(() => ({
      ref: 'wain/glm-5.2',
      model: 'glm-5.2',
      connection: { apiKey: 'sk-tenant', baseUrl: 'https://models.example/v1' },
      providerOptions: { protocol: 'responses' as const },
    }));

    const result = await executeJob(createOwnedCronJob('run task'), {
      runAgent: (...args: any[]) => runAgentMock(...args),
      agentCwd: '/tmp',
      sharedDir: '/tmp/.shared',
      resolveDefaultModel,
      userStore: {
        findById: vi.fn(() => ({
          id: 'u-wain',
          username: 'wain_user',
          role: 'user' as const,
          tenantId: 'wain',
        })),
      },
    });

    expect(result.status).toBe('ok');
    expect(result.modelRef).toBe('wain/glm-5.2');
    expect(resolveDefaultModel).toHaveBeenCalledWith('wain');
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        model: 'glm-5.2',
        modelRef: 'wain/glm-5.2',
        modelConnection: { apiKey: 'sk-tenant', baseUrl: 'https://models.example/v1' },
        modelProviderOptions: { protocol: 'responses' },
      }),
      expect.anything(),
    );
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
