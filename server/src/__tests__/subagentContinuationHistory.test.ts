import { describe, expect, it, vi } from 'vitest';

import type { RunRecord } from '../runtime/runStore.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';
import { resolveSubagentContinuationHistory } from '../runtime/subagent/subagentContinuationHistory.js';

const session = {
  sessionId: 'child-session',
  userId: 'user-1',
  tenantId: 'tenant-1',
  kind: 'subagent',
} as RuntimeSessionRecord;
const run = {
  runId: 'child-run',
  sessionId: session.sessionId,
  userId: session.userId,
  tenantId: session.tenantId,
  status: 'completed',
  requestedAt: '2026-09-12T08:00:00.000Z',
  updatedAt: '2026-09-12T08:01:00.000Z',
  metadata: {
    subagent: true,
    subagentAgentId: 'agent-1',
    subagentContinuationProtocolVersion: 1,
    parentSessionId: 'parent-session',
  },
} as RunRecord;

const resolve = (
  overrides: {
    session?: RuntimeSessionRecord | null;
    run?: RunRecord | null;
    continuation?: { previousRunId?: string; previousSessionId?: string };
  } = {},
) =>
  resolveSubagentContinuationHistory({
    continuation: overrides.continuation ?? {
      previousRunId: run.runId,
      previousSessionId: session.sessionId,
    },
    sessionCatalog: {
      get: vi.fn(async () => (overrides.session === undefined ? session : overrides.session)),
    } as never,
    runStore: {
      get: vi.fn(async () => (overrides.run === undefined ? run : overrides.run)),
    } as never,
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    parentSessionId: 'parent-session',
  });

describe('subagent continuation history authority', () => {
  it('只接受 session、run、租户、所有者和 stable id 全部一致的历史', async () => {
    await expect(resolve()).resolves.toBe(session);
    await expect(resolve({ run: { ...run, tenantId: 'tenant-2' } })).rejects.toThrow(
      /逻辑身份不一致/,
    );
    await expect(
      resolve({ run: { ...run, metadata: { ...run.metadata, subagentAgentId: 'agent-2' } } }),
    ).rejects.toThrow(/逻辑身份不一致/);
  });

  it('拒绝删除会话、旧协议和不完整指针', async () => {
    await expect(
      resolve({ session: { ...session, deletedAt: new Date().toISOString() } }),
    ).rejects.toThrow(/已删除或身份不一致/);
    await expect(
      resolve({
        run: {
          ...run,
          metadata: { ...run.metadata, subagentContinuationProtocolVersion: undefined },
        },
      }),
    ).rejects.toThrow(/逻辑身份不一致/);
    await expect(
      resolve({ continuation: { previousSessionId: session.sessionId } }),
    ).rejects.toThrow(/必须同时包含/);
  });
});
