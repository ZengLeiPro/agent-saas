import { describe, expect, it } from 'vitest';

import type { RunRecord } from '../runtime/runStore.js';
import { resolvePersistedSubagentIdentity } from '../runtime/subagent/subagentContinuation.js';

function run(overrides: Partial<RunRecord> & Pick<RunRecord, 'runId'>): RunRecord {
  return {
    sessionId: 'child-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    status: 'completed',
    model: 'provider/model',
    channel: 'web',
    requestedAt: '2026-09-12T08:00:00.000Z',
    updatedAt: '2026-09-12T08:00:01.000Z',
    metadata: {
      subagent: true,
      subagentAgentId: 'agent-1',
      subagentContinuationProtocolVersion: 1,
      parentSessionId: 'parent-1',
      agentType: 'explore',
      subagentMode: 'foreground',
      description: '调研报告',
      modelRef: 'provider/model',
      includeCompanyInfo: false,
    },
    ...overrides,
  };
}

const resolve = (records: RunRecord[]) =>
  resolvePersistedSubagentIdentity({
    records,
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    parentSessionId: 'parent-1',
    userId: 'user-1',
  });

describe('resolvePersistedSubagentIdentity', () => {
  it('恢复稳定身份并递增 continuation sequence', () => {
    const identity = resolve([
      run({
        runId: 'run-2',
        requestedAt: '2026-09-12T08:01:00.000Z',
        metadata: {
          ...run({ runId: 'unused' }).metadata,
          effort: 'high',
          subagentContinuation: { previousRunId: 'run-1', sequence: 2 },
        },
      }),
      run({ runId: 'run-1' }),
    ]);
    expect(identity.agentId).toBe('agent-1');
    expect(identity.childSessionId).toBe('child-1');
    expect(identity.previousRunId).toBe('run-2');
    expect(identity.sequence).toBe(3);
    expect(identity.effort).toBe('high');
  });

  it('把全部非终态视作 active，不把 waiting approval 当 idle', () => {
    for (const status of [
      'pending',
      'running',
      'waiting_approval',
      'waiting_user',
      'waiting_hand',
    ] as const) {
      expect(resolve([run({ runId: `run-${status}`, status })]).activePhysicalRun?.status).toBe(
        status,
      );
    }
  });

  it('忽略 steering source，并区分 background wrapper 与 physical child', () => {
    const wrapper = run({
      runId: 'task-1',
      sessionId: 'parent-1',
      status: 'running',
      metadata: {
        ...run({ runId: 'unused' }).metadata,
        backgroundTask: true,
        subagentMode: 'background',
      },
    });
    const child = run({
      runId: 'child-run',
      status: 'running',
      metadata: { ...run({ runId: 'unused' }).metadata, subagentMode: 'background' },
    });
    const source = run({
      runId: 'submsg-1',
      status: 'pending',
      metadata: {
        ...run({ runId: 'unused' }).metadata,
        subagentResumeMessage: true,
        subagentMode: 'background',
      },
    });
    const identity = resolve([source, wrapper, child]);
    expect(identity.mode).toBe('background');
    expect(identity.activeBackgroundTask?.runId).toBe('task-1');
    expect(identity.activePhysicalRun?.runId).toBe('child-run');
  });

  it('跨租户、跨父会话和跨用户记录均不可恢复', () => {
    expect(() => resolve([run({ runId: 'x', tenantId: 'tenant-2' })])).toThrow(/找不到可续接/);
    expect(() =>
      resolve([
        run({
          runId: 'x',
          metadata: {
            ...run({ runId: 'unused' }).metadata,
            parentSessionId: 'parent-2',
          },
        }),
      ]),
    ).toThrow(/找不到可续接/);
    expect(() =>
      resolve([run({ runId: 'x', userId: 'user-2', submitterUserId: 'user-2' })]),
    ).toThrow(/找不到可续接/);
  });

  it('历史 agent_type 或 mode 漂移时 fail closed', () => {
    expect(() =>
      resolve([
        run({ runId: 'a' }),
        run({
          runId: 'b',
          metadata: { ...run({ runId: 'unused' }).metadata, agentType: 'general' },
        }),
      ]),
    ).toThrow(/agent_type 历史不一致/);
    expect(() =>
      resolve([
        run({ runId: 'a' }),
        run({
          runId: 'b',
          metadata: { ...run({ runId: 'unused' }).metadata, subagentMode: 'background' },
        }),
      ]),
    ).toThrow(/mode 历史不一致/);
  });

  it('逻辑 Agent 或最近物理 run 已取消时不可恢复', () => {
    expect(() => resolve([run({ runId: 'cancelled', status: 'cancelled' })])).toThrow(
      /已取消，不能恢复/,
    );
    expect(() =>
      resolve([
        run({
          runId: 'wrapper',
          status: 'running',
          metadata: {
            ...run({ runId: 'unused' }).metadata,
            backgroundTask: true,
            subagentMode: 'background',
          },
        }),
        run({
          runId: 'child-cancelled',
          status: 'cancelled',
          requestedAt: '2026-09-12T08:01:00.000Z',
        }),
      ]),
    ).toThrow(/已取消，不能恢复/);
  });

  it('旧版协议即使带 stable id 也不可恢复', () => {
    expect(() =>
      resolve([
        run({
          runId: 'legacy',
          metadata: {
            ...run({ runId: 'unused' }).metadata,
            subagentContinuationProtocolVersion: undefined,
          },
        }),
      ]),
    ).toThrow(/旧版续接协议/);
  });
});
