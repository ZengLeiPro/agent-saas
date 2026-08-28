import { afterEach, describe, expect, it } from 'vitest';

import { WebChannel } from '../channels/web/channel.js';
import type { AgentRunDispatch } from '../agent/types.js';
import type { RunRecord, RunStatus } from '../runtime/runStore.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { FakeWebSocket } from './webChannelTestHelpers.js';

const PLATFORM_ADMIN_USER = {
  sub: 'admin-1', username: 'admin', role: 'admin' as const, tenantId: DEFAULT_TENANT_ID,
};
const noopDispatch: AgentRunDispatch = async function* () { yield { type: 'done' }; };

function dispatcherWorkerRecord(): RunRecord {
  const now = new Date().toISOString();
  return {
    runId: 'bg-drawing-1',
    sessionId: 'sub-drawing-worker-1',
    userId: PLATFORM_ADMIN_USER.sub,
    tenantId: DEFAULT_TENANT_ID,
    status: 'running',
    model: 'noop',
    channel: 'background_task',
    requestedAt: now,
    updatedAt: now,
    metadata: {
      backgroundTask: true,
      executionMode: 'dispatcher',
      parentSessionId: 'session-drawing-1',
      topLevelSessionId: 'session-drawing-1',
      wakeState: 'none',
    },
  };
}

describe('WebChannel dispatcher 父会话运行态', () => {
  const channels: WebChannel[] = [];

  afterEach(async () => {
    await Promise.all(channels.splice(0).map(channel => channel.stop()));
  });

  it('父 run 结束后仍恢复 Worker 状态，且停止按钮取消该 Worker', async () => {
    let record = dispatcherWorkerRecord();
    const runStore = {
      getActiveBySession: async () => null,
      getActiveDispatcherTaskByParentSession: async (sessionId: string) => (
        sessionId === 'session-drawing-1' && record.status === 'running' ? record : null
      ),
      get: async (runId: string) => runId === record.runId ? record : null,
      markStatus: async (runId: string, status: RunStatus, reason?: string) => {
        if (runId !== record.runId) return null;
        record = { ...record, status, statusReason: reason, updatedAt: new Date().toISOString() };
        return record;
      },
    };
    const channel = new WebChannel({
      agentCwd: '/tmp/web-channel-dispatcher-activity-test',
      enqueueRuntime: { runStore, scheduler: {} } as any,
    }, noopDispatch);
    channels.push(channel);

    await expect(channel.getStreamStatus('session-drawing-1')).resolves.toMatchObject({
      active: true, runId: 'bg-drawing-1', status: 'running',
    });

    const ws = new FakeWebSocket();
    const client = { ws, user: PLATFORM_ADMIN_USER, alive: true, lastActivityAt: Date.now() };
    await expect((channel as any).tryReplayDurableRuntimeEvents(
      client, 'session-drawing-1', { requestId: 'resume-drawing-1', skipReplay: true },
    )).resolves.toBe(true);
    expect(ws.sent).toContainEqual({ data: {
      type: 'active_stream', sessionId: 'session-drawing-1', active: true,
      runId: 'bg-drawing-1', status: 'running', requestId: 'resume-drawing-1',
    } });

    await (channel as any).handleAbortAsync(client, { action: 'abort', runId: 'bg-drawing-1' });
    expect(record.status).toBe('cancelled');
    expect(ws.sent).toContainEqual({ data: { type: 'abort_ok', runId: 'bg-drawing-1' } });
    await expect(channel.getStreamStatus('session-drawing-1')).resolves.toEqual({ active: false });
  });

  it('同租户管理员不能恢复或停止他人的 dispatcher Worker', async () => {
    let record = { ...dispatcherWorkerRecord(), userId: 'owner-1', tenantId: 'tenant-a' };
    const runStore = {
      getActiveBySession: async () => null,
      getActiveDispatcherTaskByParentSession: async () => record,
      get: async () => record,
      markStatus: async (_runId: string, status: RunStatus) => {
        record = { ...record, status, updatedAt: new Date().toISOString() };
        return record;
      },
    };
    const channel = new WebChannel({
      agentCwd: '/tmp/web-channel-dispatcher-owner-test',
      enqueueRuntime: { runStore, scheduler: {} } as any,
    }, noopDispatch);
    channels.push(channel);
    const ws = new FakeWebSocket();
    const client = {
      ws,
      user: { sub: 'tenant-admin-1', username: 'tenant-admin', role: 'admin' as const, tenantId: 'tenant-a' },
      alive: true,
      lastActivityAt: Date.now(),
    };

    await expect((channel as any).tryReplayDurableRuntimeEvents(
      client, 'session-drawing-1', { requestId: 'resume-other-worker', skipReplay: true },
    )).resolves.toBe(false);
    expect(ws.sent).toEqual([]);
    await (channel as any).handleAbortAsync(client, { action: 'abort', runId: record.runId });
    expect(record.status).toBe('running');
    expect(ws.sent).toContainEqual({ data: { type: 'error', message: 'Access denied' } });
  });
});
