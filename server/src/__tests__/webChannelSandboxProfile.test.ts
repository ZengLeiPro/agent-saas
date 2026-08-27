import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRunDispatch } from '../agent/types.js';
import { WebChannel } from '../channels/web/channel.js';
import { getTranscriptPath } from '../data/transcripts/index.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { readSessionMeta, writeSessionMeta } from '../data/transcripts/meta.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { chatMessage, FakeWebSocket, flushMicrotasks, wsClient } from './webChannelTestHelpers.js';

const RUN_TAG = randomUUID().slice(0, 8);
const USER = {
  sub: `profile-user-${RUN_TAG}`,
  username: `profile_user_${RUN_TAG}`,
  role: 'user' as const,
  tenantId: `profile${RUN_TAG}`,
};

describe('WebChannel synchronous sandbox profile fallback', () => {
  const channels: WebChannel[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const channel of channels) await channel.stop();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    channels.length = 0;
    dirs.length = 0;
    await rm(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, USER.tenantId), { recursive: true, force: true });
  });

  it('forwards a first-turn coding selection and returns the authoritative persisted pin', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-sync-profile-'));
    dirs.push(tmp);
    const sessionId = randomUUID();
    const transcriptPath = getTranscriptPath('/unused', sessionId, {
      tenantId: USER.tenantId,
      userId: USER.sub,
    });
    const dispatch: AgentRunDispatch = async function* (message) {
      expect(message.metadata).toEqual({ sandboxProfile: 'coding' });
      await writeSessionMeta(transcriptPath, {
        userId: USER.sub,
        username: USER.username,
        userRole: USER.role,
        tenantId: USER.tenantId,
        channel: 'web',
        sandboxProfile: 'coding',
        createdAt: new Date().toISOString(),
      });
      yield { type: 'session_init', sessionId };
      yield { type: 'done' };
    };
    const channel = new WebChannel({ executionConfig: createExecutionConfig(), agentCwd: tmp }, dispatch);
    channels.push(channel);
    const ws = new FakeWebSocket();
    (channel as any).eventBus = {
      emitReply: (target: any, data: any) => target?.send?.(JSON.stringify({ data })),
      emitSession: (context: any, data: any) => context?.ws?.send?.(JSON.stringify({ data })),
      emitUser: () => undefined,
      emitDual: () => undefined,
    };

    await (channel as any).processChatMessage(wsClient(ws, USER), chatMessage({
      client_msg_id: 'cm-sync-coding',
      message: '使用 coding 档位',
      sandboxProfile: 'coding',
    }));
    await flushMicrotasks();

    expect(ws.sent.find((entry) => entry.data.type === 'session')?.data).toEqual({
      type: 'session', sessionId, client_msg_id: 'cm-sync-coding', sandboxProfile: 'coding',
    });
    await expect(readSessionMeta(transcriptPath)).resolves.toMatchObject({ sandboxProfile: 'coding' });
  });

  it('keeps a coding selection when an invalid sessionId falls back to a new synchronous session', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'web-sync-invalid-profile-'));
    dirs.push(tmp);
    const newSessionId = randomUUID();
    const transcriptPath = getTranscriptPath('/unused', newSessionId, {
      tenantId: USER.tenantId,
      userId: USER.sub,
    });
    const dispatch: AgentRunDispatch = async function* (message, context) {
      expect(context.resumeSessionId).toBeUndefined();
      expect(message).toMatchObject({ chatId: '', metadata: { sandboxProfile: 'coding' } });
      await writeSessionMeta(transcriptPath, {
        userId: USER.sub,
        username: USER.username,
        userRole: USER.role,
        tenantId: USER.tenantId,
        channel: 'web',
        sandboxProfile: 'coding',
        createdAt: new Date().toISOString(),
      });
      yield { type: 'session_init', sessionId: newSessionId };
      yield { type: 'done' };
    };
    const channel = new WebChannel({ executionConfig: createExecutionConfig(), agentCwd: tmp }, dispatch);
    channels.push(channel);
    const ws = new FakeWebSocket();
    (channel as any).eventBus = {
      emitReply: (target: any, data: any) => target?.send?.(JSON.stringify({ data })),
      emitSession: (context: any, data: any) => context?.ws?.send?.(JSON.stringify({ data })),
      emitUser: () => undefined,
      emitDual: () => undefined,
    };

    await (channel as any).processChatMessage(wsClient(ws, USER), chatMessage({
      sessionId: 'missing-session',
      client_msg_id: 'cm-invalid-coding',
      message: '失效会话后继续 coding',
      sandboxProfile: 'coding',
    }));
    await flushMicrotasks();

    await expect(readSessionMeta(transcriptPath)).resolves.toMatchObject({ sandboxProfile: 'coding' });
  });
});
