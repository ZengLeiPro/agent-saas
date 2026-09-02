import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRunDispatch } from '../agent/types.js';
import { WebChannel } from '../channels/web/channel.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { chatMessage, FakeWebSocket, flushMicrotasks, wsClient } from './webChannelTestHelpers.js';

const USER = { sub: 'voice-user', username: 'voice_user', role: 'user' as const, tenantId: 'voice-tenant' };

describe('M50-04 legacy voice path fence', () => {
  const channels: WebChannel[] = [];

  afterEach(async () => {
    for (const channel of channels) await channel.stop();
    channels.length = 0;
  });

  it('rejects voiceFile.savedPath transport without invoking STT or dispatch', async () => {
    const dispatch = vi.fn();
    const channel = new WebChannel({ executionConfig: createExecutionConfig() }, dispatch as unknown as AgentRunDispatch);
    channels.push(channel);
    const ws = new FakeWebSocket();
    (channel as any).eventBus = {
      emitReply: (target: any, data: any) => { target?.send?.(JSON.stringify({ data })); },
      emitSession: (ctx: any, data: any) => { ctx?.ws?.send?.(JSON.stringify({ data })); },
      emitUser: () => {}, emitDual: () => {},
    };
    await (channel as any).processChatMessage(wsClient(ws, USER), chatMessage({
      client_msg_id: 'cm-stt-legacy', message: '',
      voiceFile: { savedPath: '/tmp/cov-voice.wav', relativePath: 'voice/cov-voice.wav', duration: 1200 },
    }));
    await flushMicrotasks();
    expect(ws.sent.at(-1)?.data).toMatchObject({ type: 'chat_rejected', reason_code: 'empty_message' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
