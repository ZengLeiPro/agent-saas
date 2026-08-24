import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import { handleWebChannelEvents } from '../channels/web/channelEventHandler.js';
import { EventBufferStore } from '../channels/web/eventBuffer.js';
import { getTranscriptPath } from '../data/transcripts/index.js';
import { getMetaPath, readSessionMeta } from '../data/transcripts/meta.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import type { ChannelContext, OutboundEvent } from '../types/index.js';

const USER = {
  id: 'session-meta-order-user',
  username: 'session_meta_order_user',
  role: 'user' as const,
  tenantId: 'session-meta-order',
};

describe('WebChannel session ownership meta ordering', () => {
  it('在向客户端发送权威 sessionId 前完成 owner meta 落盘', async () => {
    const agentCwd = await mkdtemp(join(tmpdir(), 'web-session-meta-order-'));
    const sessionId = randomUUID();
    const userCwd = resolveUserCwd(agentCwd, USER);
    const transcriptPath = getTranscriptPath(userCwd, sessionId, {
      tenantId: USER.tenantId,
      userId: USER.id,
    });
    let metaExistedAtSessionEvent = false;

    async function* events(): AsyncGenerator<OutboundEvent> {
      yield { type: 'session_init', sessionId };
      yield { type: 'done' };
    }

    const context: ChannelContext = { channel: 'web', user: USER };
    const eventBufferStore = new EventBufferStore();
    try {
      await handleWebChannelEvents({
        displayConfig: {},
        agentCwd,
        eventBufferStore,
        eventBus: {
          emitSession: (_ctx: unknown, data: { type?: string }) => {
            if (data.type === 'session') {
              metaExistedAtSessionEvent = existsSync(getMetaPath(transcriptPath));
            }
          },
          emitReply: () => undefined,
          emitUser: () => undefined,
          emitDual: () => undefined,
        } as any,
        setIdempotency: () => undefined,
        generateTitle: async () => null,
      }, events(), {} as WebSocket, context, undefined, { streamId: 'stream-1' }, {
        userMessage: '你好',
        userDisplayContent: '你好',
        clientMsgId: 'client-1',
        isNewSession: true,
        getSessionId: () => sessionId,
      });

      expect(metaExistedAtSessionEvent).toBe(true);
      expect(await readSessionMeta(transcriptPath)).toMatchObject({
        userId: USER.id,
        username: USER.username,
        tenantId: USER.tenantId,
        channel: 'web',
      });
    } finally {
      await rm(agentCwd, { recursive: true, force: true });
    }
  });
});
