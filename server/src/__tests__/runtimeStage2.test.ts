import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 指向真实 workspace-shared/prompts/，避免每个 tmp cwd 都要拷模板
const SHARED_DIR = resolve(process.cwd(), '../workspace-shared');

import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import {
  createRawApprovalResumeDispatch,
  createRawRuntimeRunDispatch,
  failRunningRunForWallClock,
  loadRawRuntimeWakeState,
  markRunState,
  RunStateTrackingEventStore,
  type SessionLockAcquirer,
  type SessionLockHandle,
} from '../runtime/rawRuntimeRunDispatch.js';
import type { RunStore } from '../runtime/runStore.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';
import type { EventStore, PlatformEvent } from '../runtime/types.js';
import { runtimeRunController } from '../runtime/runController.js';
import type { OutboundEvent } from '../types/index.js';
import { MemorySessionCatalog } from './runtimeStage2.testHelpers.js';

describe('runtime stage 2 primitives', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('web abort 后把 session 从 running 收口为 idle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'runtime-web-abort-'));
    cleanupDirs.add(cwd);
    const sessionCatalog = new MemorySessionCatalog();
    const abortController = new AbortController();
    abortController.abort('web_abort');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'AbortError'));

    const dispatch = createRawRuntimeRunDispatch({
      agentCwd: cwd,
      sharedDir: SHARED_DIR,
      sessionCatalog,
      memory: { enabled: false },
    });
    let sessionId: string | undefined;
    for await (const event of dispatch(
      { channel: 'web', chatId: 'chat-abort', content: '停止测试' },
      { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
      {
        abortController,
        modelConnection: { apiKey: 'sk-test' },
        skipSystemPrompt: true,
        maxTurns: 1,
      },
    )) {
      if (event.type === 'session_init') sessionId = event.sessionId;
    }

    expect(sessionId).toBeTruthy();
    expect((await sessionCatalog.get(sessionId!))?.status).toBe('idle');
  });

  it('direct DingTalk first run pins a new delegated session to v2', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'runtime-dingtalk-v2-pin-'));
    cleanupDirs.add(cwd);
    const sessionCatalog = new MemorySessionCatalog();
    const abortController = new AbortController();
    abortController.abort('test_complete_after_pin');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const dispatch = createRawRuntimeRunDispatch({
      agentCwd: cwd,
      sharedDir: SHARED_DIR,
      sessionCatalog,
      memory: { enabled: false },
      memoryWriteDelegationEnabled: () => true,
    });
    let sessionId: string | undefined;
    for await (const event of dispatch(
      { channel: 'dingtalk', chatId: 'chat-dingtalk-v2', content: '首轮 pin' },
      { channel: 'dingtalk', user: { id: 'user-1', username: 'alice', role: 'user', tenantId: 'kaiyan' } },
      { abortController, modelConnection: { apiKey: 'sk-test' }, skipSystemPrompt: true, maxTurns: 1 },
    )) {
      if (event.type === 'session_init') sessionId = event.sessionId;
    }
    expect(sessionId).toBeTruthy();
    await expect(sessionCatalog.get(sessionId!)).resolves.toMatchObject({ memoryPolicyVersion: 'v2' });
  });

  it('direct runtime lease 竞争失败会延后执行，不把 winner 的 run 标成 failed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'runtime-direct-lease-contended-'));
    cleanupDirs.add(cwd);
    const sessionCatalog = new MemorySessionCatalog();
    const markStatus = vi.fn(async () => null);
    const runStore = {
      upsertPending: async (input: { runId: string; sessionId: string; metadata?: Record<string, unknown> }) => ({
        runId: input.runId,
        sessionId: input.sessionId,
        status: 'pending' as const,
        requestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: input.metadata ?? {},
      }),
      acquireLease: async () => null,
      markStatus,
    } as unknown as RunStore;
    const dispatch = createRawRuntimeRunDispatch({
      agentCwd: cwd,
      sharedDir: SHARED_DIR,
      sessionCatalog,
      runStore,
      memory: { enabled: false },
    });
    const events: OutboundEvent[] = [];

    for await (const event of dispatch(
      { channel: 'web', chatId: 'chat-contended', content: '不得重复执行' },
      { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
      {
        runtimeRunId: 'run-contended',
        modelConnection: { apiKey: 'sk-test' },
        skipSystemPrompt: true,
        maxTurns: 1,
      },
    )) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['session_init']);
    expect(markStatus).not.toHaveBeenCalled();
  });

  it('PG session lease 丢失会中止 dispatch 并把 session 收口为 idle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'runtime-session-lease-lost-'));
    cleanupDirs.add(cwd);
    const sessionCatalog = new MemorySessionCatalog();
    const release = vi.fn(async () => undefined);
    const sessionLock: SessionLockAcquirer = {
      async tryAcquire(_sessionId, options) {
        options?.onLost?.(new Error('session lease lost'));
        return { release };
      },
    };
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'AbortError'));

    const dispatch = createRawRuntimeRunDispatch({
      agentCwd: cwd,
      sharedDir: SHARED_DIR,
      sessionCatalog,
      sessionLock,
      memory: { enabled: false },
    });
    let sessionId: string | undefined;
    for await (const event of dispatch(
      { channel: 'web', chatId: 'chat-lease-lost', content: '租约丢失测试' },
      { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
      {
        modelConnection: { apiKey: 'sk-test' },
        skipSystemPrompt: true,
        maxTurns: 1,
      },
    )) {
      if (event.type === 'session_init') sessionId = event.sessionId;
    }

    expect(sessionId).toBeTruthy();
    expect((await sessionCatalog.get(sessionId!))?.status).toBe('idle');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('Session 写入在治理 preflight 前失败时仍释放已获取的 session lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'runtime-session-early-failure-'));
    cleanupDirs.add(cwd);
    const release = vi.fn(async () => undefined);
    const sessionCatalog = new MemorySessionCatalog();
    vi.spyOn(sessionCatalog, 'upsert').mockRejectedValue(new Error('session write failed'));
    const dispatch = createRawRuntimeRunDispatch({
      agentCwd: cwd,
      sharedDir: SHARED_DIR,
      sessionCatalog,
      sessionLock: { tryAcquire: vi.fn(async () => ({ release })) },
      memory: { enabled: false },
    });

    const events: OutboundEvent[] = [];
    for await (const event of dispatch(
      { channel: 'web', chatId: 'chat-early-failure', content: '锁释放测试' },
      { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
      { modelConnection: { apiKey: 'sk-test' }, skipSystemPrompt: true },
    )) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('session write failed') }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('FileEventStore supports appendBatch and cursor pages without changing list()', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eventstore-v2-'));
    cleanupDirs.add(cwd);
    const store = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));

    await store.appendBatch?.([
      { type: 'run_started', runId: 'run-1', sessionId: 'session-1', model: 'gpt-5.5', channel: 'web' },
      { type: 'user_message', runId: 'run-1', sessionId: 'session-1', content: 'A' },
      { type: 'assistant_message', runId: 'run-1', sessionId: 'session-1', content: 'B' },
    ]);

    expect((await store.list('session-1')).map((event) => event.type)).toEqual([
      'run_started',
      'user_message',
      'assistant_message',
    ]);

    const first = await store.listPage?.('session-1', { limit: 2 });
    expect(first?.events.map((event) => event.type)).toEqual(['run_started', 'user_message']);
    expect(first?.events.map((event) => (event as typeof event & { sequence?: number }).sequence)).toEqual([1, 2]);
    expect(first?.nextCursor).toBe('2');
    expect(first?.hasMore).toBe(true);

    // Reconnect must resume from the numeric read projection, never from the persisted
    // UUID event id (which parseFileCursor would degrade to offset 0 and replay in full).
    const reconnectCursor = String((first?.events.at(-1) as PlatformEvent & { sequence: number }).sequence);
    expect(reconnectCursor).not.toBe(first?.events.at(-1)?.id);
    const second = await store.listPage?.('session-1', { afterCursor: reconnectCursor, limit: 2 });
    expect(second?.events.map((event) => event.type)).toEqual(['assistant_message']);
    expect(second?.events.map((event) => (event as typeof event & { sequence?: number }).sequence)).toEqual([3]);
    expect(second?.nextCursor).toBeUndefined();
    expect(second?.hasMore).toBe(false);
  });

  it('FileEventStore.list can exclude replay-heavy event types without changing the default list', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eventstore-exclude-'));
    cleanupDirs.add(cwd);
    const store = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));

    await store.appendBatch?.([
      { type: 'run_started', runId: 'run-1', sessionId: 'session-1', model: 'gpt-5.5', channel: 'web' },
      { type: 'tool_output_delta', runId: 'run-1', sessionId: 'session-1', invocationId: 'inv-1', toolCallId: 'call-1', content: 'chunk' },
      { type: 'tool_progress', runId: 'run-1', sessionId: 'session-1', invocationId: 'inv-1', toolCallId: 'call-1', content: '50%' },
      { type: 'assistant_stream_event', runId: 'run-1', sessionId: 'session-1', blockType: 'text', phase: 'delta', content: 'legacy' },
      { type: 'assistant_message', runId: 'run-1', sessionId: 'session-1', content: 'done' },
    ]);

    expect((await store.list('session-1')).map((event) => event.type)).toEqual([
      'run_started',
      'tool_output_delta',
      'tool_progress',
      'assistant_stream_event',
      'assistant_message',
    ]);
    expect((await store.list('session-1', {
      excludeTypes: ['tool_output_delta', 'tool_progress', 'assistant_stream_event'],
    })).map((event) => event.type)).toEqual([
      'run_started',
      'assistant_message',
    ]);
  });

  it('FileEventStore usage projection excludes full tool content', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eventstore-usage-projection-'));
    cleanupDirs.add(cwd);
    const store = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    await store.append({
      type: 'tool_result',
      runId: 'run-1',
      sessionId: 'session-1',
      toolCallId: 'call-1',
      toolName: 'Shell',
      content: 'full-content',
    });

    const [projected] = await store.list('session-1', { projection: 'usage' });
    expect(projected).not.toHaveProperty('content');
    expect(projected).not.toHaveProperty('modelContent');
  });

  it('RunStateTrackingEventStore 透传 list/listPage 查询参数', async () => {
    const list = vi.fn(async () => []);
    const listPage = vi.fn(async () => ({ events: [], hasMore: false }));
    const inner = {
      append: vi.fn(),
      list,
      listPage,
    } as unknown as EventStore;
    const store = new RunStateTrackingEventStore(inner, undefined);
    const listOptions = { excludeTypes: ['model_request_started' as const] };
    const pageOptions = { afterCursor: 'cursor-1', limit: 20, runId: 'run-1', type: 'model_request_finished' as const };

    await store.list('session-1', listOptions);
    await store.listPage?.('session-1', pageOptions);

    expect(list).toHaveBeenCalledWith('session-1', listOptions);
    expect(listPage).toHaveBeenCalledWith('session-1', pageOptions);
  });

  it('RunStateTrackingEventStore 先 CAS 再发布 success/failed/cancelled 终态及原因', async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const append = vi.fn(async (event: Record<string, unknown>) => {
      const stored = { id: `event-${persisted.length + 1}`, timestamp: new Date().toISOString(), ...event };
      persisted.push(stored);
      return stored;
    });
    const inner = { append, list: vi.fn(async () => []) } as unknown as EventStore;
    const statuses = new Map<string, string>([
      ['run-success', 'running'], ['run-error', 'running'], ['run-cancelled', 'running'],
    ]);
    const markStatusIfCurrent = vi.fn(async (
      runId: string,
      expected: readonly string[],
      next: string,
      _reason?: string,
      metadata?: Record<string, unknown>,
    ) => {
      if (!expected.includes(statuses.get(runId)!)) return null;
      statuses.set(runId, next);
      return { runId, tenantId: 'tenant-test', status: next, metadata };
    });
    const runStore = {
      get: vi.fn(async (runId: string) => ({
        runId, tenantId: 'tenant-test', status: statuses.get(runId), metadata: {},
      })),
      markStatus: vi.fn(),
      markStatusIfCurrent,
      patchMetadata: vi.fn(async () => null),
    } as unknown as RunStore;
    const store = new RunStateTrackingEventStore(inner, runStore);

    await store.append({ type: 'run_finished', runId: 'run-success', sessionId: 'session-1', subtype: 'success', numTurns: 1 });
    await store.append({
      type: 'run_finished', runId: 'run-error', sessionId: 'session-1', subtype: 'error', error: 'model error', numTurns: 1,
    });
    await store.append({
      type: 'run_finished', runId: 'run-cancelled', sessionId: 'session-1', subtype: 'interrupted', numTurns: 1,
    });

    expect(markStatusIfCurrent).toHaveBeenNthCalledWith(
      1, 'run-success', expect.arrayContaining(['running']), 'completed', undefined, expect.any(Object),
    );
    expect(markStatusIfCurrent).toHaveBeenNthCalledWith(
      2, 'run-error', expect.arrayContaining(['running']), 'failed', 'model error', expect.any(Object),
    );
    expect(markStatusIfCurrent).toHaveBeenNthCalledWith(
      3, 'run-cancelled', expect.arrayContaining(['running']), 'cancelled', 'interrupted', expect.any(Object),
    );
    expect(persisted.filter((event) => event.type === 'run_finished')).toHaveLength(3);
    expect(persisted.filter((event) => event.type === 'run_state_changed').map((event) => event.status))
      .toEqual(['completed', 'failed', 'cancelled']);
  });

  it('RunStateTrackingEventStore 不把 terminal run 的迟到审批恢复为 running', async () => {
    const append = vi.fn(async (event: Record<string, unknown>) => ({
      id: `event-${append.mock.calls.length}`,
      timestamp: new Date().toISOString(),
      ...event,
    }));
    const markStatus = vi.fn();
    const store = new RunStateTrackingEventStore({
      append,
      list: vi.fn(async () => []),
    } as unknown as EventStore, {
      get: vi.fn(async () => ({ status: 'cancelled' })),
      markStatus,
    } as unknown as RunStore);

    await store.append({
      type: 'approval_resolved',
      runId: 'cancelled-run',
      sessionId: 'session-1',
      approvalId: 'approval-1',
      decision: 'rejected',
    });

    expect(append).toHaveBeenCalledTimes(1);
    expect(markStatus).not.toHaveBeenCalled();
  });

  it('RunStateTrackingEventStore 不为状态写入竞态追加虚假的 running 事件', async () => {
    const append = vi.fn(async (event: Record<string, unknown>) => ({
      id: `event-${append.mock.calls.length}`,
      timestamp: new Date().toISOString(),
      ...event,
    }));
    const markStatus = vi.fn(async () => ({ status: 'cancelled' }));
    const store = new RunStateTrackingEventStore({
      append,
      list: vi.fn(async () => []),
    } as unknown as EventStore, {
      get: vi.fn(async () => ({ status: 'running' })),
      markStatus,
    } as unknown as RunStore);

    await store.append({
      type: 'approval_resolved',
      runId: 'racing-run',
      sessionId: 'session-1',
      approvalId: 'approval-1',
      decision: 'rejected',
    });

    expect(markStatus).toHaveBeenCalledWith('racing-run', 'running', 'approval_resolved:approval-1');
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('orphaned 与其它终态同样由 durable CAS 裁决，败者不发布 cancelled', async () => {
    let status = 'running';
    let metadata: Record<string, unknown> = {};
    const persisted: Array<Record<string, unknown>> = [];
    const eventStore = {
      append: vi.fn(async (event: Record<string, unknown>) => {
        const stored = { id: `event-${persisted.length + 1}`, timestamp: new Date().toISOString(), ...event };
        persisted.push(stored);
        return stored;
      }),
      list: vi.fn(async () => []),
    } as unknown as EventStore;
    const runStore = {
      get: vi.fn(async () => ({ runId: 'run-orphaned', tenantId: 'tenant-test', status, metadata })),
      markStatus: vi.fn(),
      markStatusIfCurrent: vi.fn(async (
        _runId: string, expected: readonly string[], next: string, _reason?: string, patch?: Record<string, unknown>,
      ) => {
        if (!expected.includes(status)) return null;
        status = next;
        metadata = { ...metadata, ...patch };
        return { runId: 'run-orphaned', tenantId: 'tenant-test', status, metadata };
      }),
      patchMetadata: vi.fn(async (_runId: string, patch: Record<string, unknown>) => {
        metadata = { ...metadata, ...patch };
        return { runId: 'run-orphaned', tenantId: 'tenant-test', status, metadata };
      }),
    } as unknown as RunStore;

    await markRunState(runStore, eventStore, 'session-orphaned', 'run-orphaned', 'orphaned', 'lease_lost');
    await markRunState(runStore, eventStore, 'session-orphaned', 'run-orphaned', 'cancelled', 'late_cancel');

    expect(status).toBe('orphaned');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ type: 'run_state_changed', status: 'orphaned', reason: 'lease_lost' });
  });

  it('墙钟 CAS 败给已完成 run 时不 abort，也不发布 failed 事件', async () => {
    const append = vi.fn(async (event: Record<string, unknown>) => ({
      id: 'event-1', timestamp: new Date().toISOString(), ...event,
    }));
    const eventStore = { append, list: vi.fn(async () => []) } as unknown as EventStore;
    const markStatusIfCurrent = vi.fn(async () => null);
    const abortController = new AbortController();
    const runStore = {
      get: vi.fn(async () => ({ runId: 'run-completed', tenantId: 'tenant-test', status: 'completed', metadata: {} })),
      markStatus: vi.fn(),
      markStatusIfCurrent,
    } as unknown as RunStore;

    const shouldAbort = await failRunningRunForWallClock({
      runStore,
      eventStore,
      sessionId: 'session-completed',
      runId: 'run-completed',
      abortController,
    });

    expect(shouldAbort).toBe(false);
    expect(abortController.signal.aborted).toBe(false);
    expect(markStatusIfCurrent).toHaveBeenCalledWith(
      'run-completed', ['running'], 'failed', 'run_max_wall_clock_exceeded', expect.any(Object),
    );
    expect(append).not.toHaveBeenCalled();
  });

  it('墙钟 CAS 成功后即使事件 append 失败也可靠 abort，并保留可重投 outbox', async () => {
    let status = 'running';
    let metadata: Record<string, unknown> = {};
    const append = vi.fn()
      .mockRejectedValueOnce(new Error('event store unavailable'))
      .mockImplementation(async (event: Record<string, unknown>) => ({
        id: 'event-replayed', timestamp: new Date().toISOString(), ...event,
      }));
    const eventStore = { append, list: vi.fn(async () => []) } as unknown as EventStore;
    const runStore = {
      get: vi.fn(async () => ({ runId: 'run-timeout', tenantId: 'tenant-test', status, metadata })),
      markStatus: vi.fn(),
      markStatusIfCurrent: vi.fn(async (
        _runId: string, expected: readonly string[], next: string, _reason?: string, patch?: Record<string, unknown>,
      ) => {
        if (!expected.includes(status)) return null;
        status = next;
        metadata = { ...metadata, ...patch };
        return { runId: 'run-timeout', tenantId: 'tenant-test', status, metadata };
      }),
      patchMetadata: vi.fn(async (_runId: string, patch: Record<string, unknown>) => {
        metadata = { ...metadata, ...patch };
        return { runId: 'run-timeout', tenantId: 'tenant-test', status, metadata };
      }),
    } as unknown as RunStore;
    const abortController = new AbortController();
    const warn = vi.fn();

    await expect(failRunningRunForWallClock({
      runStore,
      eventStore,
      sessionId: 'session-timeout',
      runId: 'run-timeout',
      abortController,
      logger: { warn },
    })).resolves.toBe(true);

    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toMatchObject({ message: 'run_max_wall_clock_exceeded' });
    expect(metadata.terminalEventOutbox).toMatchObject({ state: 'failed', terminalStatus: 'failed', attempts: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('event append failed'));

    const { retryPendingTerminalEvents } = await import('../runtime/runTerminalCoordinator.js');
    await expect(retryPendingTerminalEvents({ runStore, eventStore, runId: 'run-timeout' })).resolves.toBe(true);
    expect(metadata.terminalEventOutbox).toMatchObject({ state: 'delivered', attempts: 2 });
    expect(append).toHaveBeenCalledTimes(2);
  });

  it.each(['success-first', 'timeout-first'] as const)(
    'success-vs-timeout 双向竞态只允许 durable CAS 赢家发布终态：%s',
    async (winner) => {
      let status = 'running';
      let metadata: Record<string, unknown> = {};
      const persisted: Array<Record<string, unknown>> = [];
      const inner = {
        append: vi.fn(async (event: Record<string, unknown>) => {
          const stored = { id: `event-${persisted.length + 1}`, timestamp: new Date().toISOString(), ...event };
          persisted.push(stored);
          return stored;
        }),
        appendBatch: vi.fn(async (events: Record<string, unknown>[]) => Promise.all(events.map(async (event) => {
          const stored = { id: `event-${persisted.length + 1}`, timestamp: new Date().toISOString(), ...event };
          persisted.push(stored);
          return stored;
        }))),
        list: vi.fn(async () => []),
      } as unknown as EventStore;
      const runStore = {
        get: vi.fn(async () => ({ runId: 'run-race', tenantId: 'tenant-test', status, metadata })),
        markStatus: vi.fn(),
        markStatusIfCurrent: vi.fn(async (
          _runId: string, expected: readonly string[], next: string, _reason?: string, patch?: Record<string, unknown>,
        ) => {
          if (!expected.includes(status)) return null;
          status = next;
          metadata = { ...metadata, ...patch };
          return { runId: 'run-race', tenantId: 'tenant-test', status, metadata };
        }),
        patchMetadata: vi.fn(async (_runId: string, patch: Record<string, unknown>) => {
          metadata = { ...metadata, ...patch };
          return { runId: 'run-race', tenantId: 'tenant-test', status, metadata };
        }),
      } as unknown as RunStore;
      const store = new RunStateTrackingEventStore(inner, runStore);
      const abortController = new AbortController();
      const finish = () => store.append({
        type: 'run_finished', runId: 'run-race', sessionId: 'session-race', subtype: 'success', numTurns: 1,
      });
      const timeout = () => failRunningRunForWallClock({
        runStore, eventStore: inner, sessionId: 'session-race', runId: 'run-race', abortController,
      });

      if (winner === 'success-first') {
        await finish();
        await expect(timeout()).resolves.toBe(false);
        expect(abortController.signal.aborted).toBe(false);
      } else {
        await expect(timeout()).resolves.toBe(true);
        await expect(finish()).rejects.toThrow('run terminal CAS lost');
        expect(abortController.signal.aborted).toBe(true);
      }

      expect(status).toBe(winner === 'success-first' ? 'completed' : 'failed');
      expect(persisted.filter((event) => event.type === 'run_state_changed')).toHaveLength(1);
      expect(persisted.filter((event) => event.type === 'run_state_changed')[0]?.status).toBe(status);
      expect(persisted.filter((event) => event.type === 'run_finished')).toHaveLength(winner === 'success-first' ? 1 : 0);
    },
  );

  it('EventBackedApprovalStore persists approval state inside runtime events', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'approval-events-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-1');

    const approval = await approvalStore.create({
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolId: 'Write',
      toolName: 'Write',
      displayName: 'Write File',
      input: { path: 'a.txt', content: 'A' },
    });
    expect((await approvalStore.get(approval.id))?.status).toBe('pending');

    const [first, second] = await Promise.all([
      approvalStore.resolvePending(approval.id, 'approved', 'ok'),
      approvalStore.resolvePending(approval.id, 'approved', 'duplicate'),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await approvalStore.get(approval.id))?.status).toBe('approved');
    expect((await eventStore.list('session-1')).map((event) => event.type)).toEqual([
      'approval_requested',
      'approval_resolved',
    ]);
  });

  it('loadRawRuntimeWakeState restores replay state from session catalog and event log', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'wake-state-'));
    cleanupDirs.add(cwd);
    const sessionCatalog = new MemorySessionCatalog();
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    const session: RuntimeSessionRecord = {
      sessionId: 'session-wake',
      userId: 'admin-1',
      username: 'admin',
      channel: 'web',
      cwd,
      transcriptPath: join(cwd, 'session.jsonl'),
      modelRef: 'openai-agents/gpt55',
      executionTarget: 'server-container',
      workspaceId: 'session-wake',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await sessionCatalog.upsert(session);
    await eventStore.append({
      type: 'assistant_tool_calls',
      runId: 'run-1',
      sessionId: 'session-wake',
      content: '',
      toolCalls: [{
        id: 'call-write',
        name: 'Write',
        arguments: JSON.stringify({ path: 'a.txt', content: 'A' }),
      }],
    });
    await new EventBackedApprovalStore(eventStore, 'session-wake').create({
      sessionId: 'session-wake',
      runId: 'run-1',
      toolCallId: 'call-write',
      toolId: 'Write',
      toolName: 'Write',
      input: { path: 'a.txt', content: 'A' },
    });

    const wakeState = await loadRawRuntimeWakeState({
      agentCwd: cwd,
      sharedDir: SHARED_DIR,
      sessionCatalog,
      eventStoreFactory: () => eventStore,
    }, 'session-wake');

    expect(wakeState?.session.executionTarget).toBe('server-container');
    expect(wakeState?.replayState.pendingApprovals).toHaveLength(1);
    expect(wakeState?.replayState.pendingApprovals[0]?.toolCallId).toBe('call-write');
  });

  it('approval resume dispatch yields error when session lock is taken', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'runtime-lock-taken-'));
    cleanupDirs.add(cwd);
    const sessionCatalog = new MemorySessionCatalog();
    await sessionCatalog.upsert({
      sessionId: 'session-locked',
      userId: 'admin-1',
      username: 'admin',
      channel: 'web',
      cwd,
      transcriptPath: join(cwd, 'session-locked.jsonl'),
      modelRef: 'openai-agents/gpt55',
      executionTarget: 'server-local',
      workspaceId: 'session-locked',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let tryAcquireCalls = 0;
    const sessionLock: SessionLockAcquirer = {
      async tryAcquire(sessionId: string) {
        tryAcquireCalls += 1;
        expect(sessionId).toBe('session-locked');
        return null; // 模拟锁已被另一 brain 持有
      },
    };

    const prevApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-dummy-for-lock-test';

    try {
      const dispatch = createRawApprovalResumeDispatch({
        agentCwd: cwd,
        sharedDir: SHARED_DIR,
        sessionCatalog,
        sessionLock,
      });

      const events: OutboundEvent[] = [];
      for await (const event of dispatch({
        approvalId: 'appr-1',
        response: { allow: true },
        sessionId: 'session-locked',
        context: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      })) {
        events.push(event);
      }

      expect(tryAcquireCalls).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('error');
      expect(events[0]?.error).toContain('已被另一个 brain 持有');
    } finally {
      if (prevApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevApiKey;
    }
  });

  it('approval resume dispatch releases session lock when approval not found', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'runtime-lock-release-'));
    cleanupDirs.add(cwd);
    const transcriptPath = join(cwd, 'session-release.jsonl');
    await writeFile(transcriptPath, '', 'utf-8');

    const sessionCatalog = new MemorySessionCatalog();
    await sessionCatalog.upsert({
      sessionId: 'session-release',
      userId: 'admin-1',
      username: 'admin',
      channel: 'web',
      cwd,
      transcriptPath,
      modelRef: 'openai-agents/gpt55',
      executionTarget: 'server-local',
      workspaceId: 'session-release',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let releaseCalls = 0;
    const handle: SessionLockHandle = {
      async release() {
        releaseCalls += 1;
      },
    };
    let tryAcquireCalls = 0;
    const sessionLock: SessionLockAcquirer = {
      async tryAcquire(sessionId: string) {
        tryAcquireCalls += 1;
        expect(sessionId).toBe('session-release');
        return handle;
      },
    };

    const prevApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-dummy-for-release-test';
    const armWallClock = vi.spyOn(runtimeRunController, 'armWallClock');
    const disarmWallClock = vi.spyOn(runtimeRunController, 'disarmWallClock');

    try {
      const dispatch = createRawApprovalResumeDispatch({
        agentCwd: cwd,
        sharedDir: SHARED_DIR,
        sessionCatalog,
        sessionLock,
      });

      const events: OutboundEvent[] = [];
      for await (const event of dispatch({
        approvalId: 'appr-not-exist',
        response: { allow: true },
        sessionId: 'session-release',
        context: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      })) {
        events.push(event);
      }

      // loop.resumeApproval 因 approval 不存在 yield 'error'，然后 finally 释放锁
      expect(tryAcquireCalls).toBe(1);
      expect(releaseCalls).toBe(1);
      expect(armWallClock).toHaveBeenCalledTimes(1);
      expect(disarmWallClock).toHaveBeenCalledWith(expect.stringMatching(/^resume-/));
      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
    } finally {
      if (prevApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevApiKey;
    }
  });
});
