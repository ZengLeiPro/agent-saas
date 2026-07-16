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
  loadRawRuntimeWakeState,
  RunStateTrackingEventStore,
  type SessionLockAcquirer,
  type SessionLockHandle,
} from '../runtime/rawRuntimeRunDispatch.js';
import type { RuntimeSessionRecord, SessionCatalog } from '../runtime/sessionCatalog.js';
import type { EventStore } from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

class MemorySessionCatalog implements SessionCatalog {
  private readonly records = new Map<string, RuntimeSessionRecord>();

  async upsert(record: RuntimeSessionRecord): Promise<void> {
    this.records.set(record.sessionId, record);
  }

  async get(sessionId: string): Promise<RuntimeSessionRecord | null> {
    return this.records.get(sessionId) ?? null;
  }

  async markStatus(sessionId: string, status: RuntimeSessionRecord['status']): Promise<void> {
    const existing = this.records.get(sessionId);
    if (existing) this.records.set(sessionId, { ...existing, status, updatedAt: new Date().toISOString() });
  }

  async findTranscriptPath(sessionId: string): Promise<string | null> {
    return this.records.get(sessionId)?.transcriptPath ?? null;
  }
}

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
    expect(first?.hasMore).toBe(true);
    const second = await store.listPage?.('session-1', { afterCursor: first?.nextCursor, limit: 2 });
    expect(second?.events.map((event) => event.type)).toEqual(['assistant_message']);
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
      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
    } finally {
      if (prevApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevApiKey;
    }
  });
});
