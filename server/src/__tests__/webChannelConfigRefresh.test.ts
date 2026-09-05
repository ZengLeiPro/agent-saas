import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebChannel, type WebChannelConfig } from '../channels/web/channel.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import {
  chatMessage,
  FakeWebSocket,
  flushMicrotasks,
  wsClient,
} from './webChannelTestHelpers.js';

const USER = {
  sub: 'config-refresh-user',
  username: 'config_refresh_user',
  role: 'user' as const,
  tenantId: 'config-refresh-tenant',
};

interface Rig {
  channel: WebChannel;
  ws: FakeWebSocket;
}

describe('WebChannel shared config refresh gate', () => {
  const channels: WebChannel[] = [];
  const dirs: string[] = [];

  async function makeRig(extra: Partial<WebChannelConfig>): Promise<Rig> {
    const agentCwd = await mkdtemp(join(tmpdir(), 'web-config-refresh-'));
    dirs.push(agentCwd);
    const channel = new WebChannel({
      agentCwd,
      executionConfig: createExecutionConfig(),
      ...extra,
    }, async function* () { yield { type: 'done' as const }; });
    channels.push(channel);
    return { channel, ws: new FakeWebSocket() };
  }

  async function send(rig: Rig, overrides: Record<string, unknown>): Promise<void> {
    await (rig.channel as any).processChatMessage(
      wsClient(rig.ws, USER),
      chatMessage(overrides),
    );
    await flushMicrotasks();
  }

  function expectRejectedBeforeAck(rig: Rig, reasonCode: string): void {
    expect(rig.ws.sent.at(-1)?.data).toMatchObject({
      type: 'chat_rejected',
      reason_code: reasonCode,
    });
    expect(rig.ws.sent.some(({ data }) => data.type === 'chat_ack')).toBe(false);
  }

  afterEach(async () => {
    try {
      for (const channel of channels) await channel.stop();
    } finally {
      channels.length = 0;
      await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
      dirs.length = 0;
    }
  });

  it('fails closed before ACK when shared config refresh returns false or throws', async () => {
    const unavailable = vi.fn().mockResolvedValue(false);
    const falseRig = await makeRig({ refreshSharedConfig: unavailable });
    await send(falseRig, { client_msg_id: 'config-refresh-false', message: '文本消息' });
    expect(unavailable).toHaveBeenCalledOnce();
    expectRejectedBeforeAck(falseRig, 'model_not_allowed');

    const failed = vi.fn().mockRejectedValue(new Error('refresh failed'));
    const errorRig = await makeRig({ refreshSharedConfig: failed });
    await send(errorRig, { client_msg_id: 'config-refresh-error', message: '文本消息' });
    expect(failed).toHaveBeenCalledOnce();
    expectRejectedBeforeAck(errorRig, 'model_not_allowed');
  });

  it('forces refresh before canonical voice authority lookup and rejects refresh failure', async () => {
    const attachmentId = '11111111-1111-4111-8111-111111111111';
    const refreshSharedConfig = vi.fn().mockResolvedValue(false);
    const getAuthoritative = vi.fn();
    const rig = await makeRig({
      refreshSharedConfig,
      voiceTranscriptionService: { getAuthoritative } as any,
    });

    await send(rig, {
      clientCapabilities: ['chat_submission_v1'],
      submission: {
        version: 1,
        text: '用户编辑后的转写',
        clientMsgId: 'config-refresh-voice',
        target: {},
        deliveryMode: 'queue',
        attachments: [{
          attachmentId,
          display: {
            originalName: 'voice.wav',
            mimeType: 'audio/wav',
            size: 64,
            isImage: false,
          },
        }],
        voice: {
          voiceIntentId: '22222222-2222-4222-8222-222222222222',
          uploadRequestId: '33333333-3333-4333-8333-333333333333',
          attachmentId,
          transcriptionId: '44444444-4444-4444-8444-444444444444',
          durationMs: 1_500,
          transcript: {
            status: 'ready',
            text: '用户编辑后的转写',
            edited: true,
            source: 'server_stt',
          },
        },
      },
    });

    expect(refreshSharedConfig).toHaveBeenCalledWith(true);
    expect(getAuthoritative).not.toHaveBeenCalled();
    expectRejectedBeforeAck(rig, 'stt_failed');
  });
});
