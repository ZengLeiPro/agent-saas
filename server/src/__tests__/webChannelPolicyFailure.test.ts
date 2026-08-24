import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { handleWebChannelEvents, type WebChannelEventDependencies } from '../channels/web/channelEventHandler.js';
import type { ChannelContext, OutboundEvent } from '../types/index.js';

async function* policyFailureEvents(): AsyncGenerator<OutboundEvent> {
  yield { type: 'session_init', sessionId: 'session-policy', runId: 'run-policy' };
  yield {
    type: 'error',
    error: '当前模型受策略限制，请切换其他模型继续。',
    failureKind: 'policy_rejection',
    recoveryAction: 'switch_model',
  };
}

describe('Web channel policy failure projection', () => {
  it('preserves runId and structured recovery fields in the live done event', async () => {
    const emitted: object[] = [];
    const dependencies = {
      displayConfig: {},
      eventBus: {
        emitSession: vi.fn((_context: unknown, event: object) => { emitted.push(event); }),
        emitReply: vi.fn((_ws: unknown, event: object) => { emitted.push(event); }),
        emitUser: vi.fn(),
        emitDual: vi.fn(),
      },
      eventBufferStore: {
        create: vi.fn(),
        push: vi.fn(),
        remove: vi.fn(),
      },
      setIdempotency: vi.fn(),
      generateTitle: vi.fn(async () => null),
    } as unknown as WebChannelEventDependencies;
    const context = { channel: 'web' } satisfies ChannelContext;

    await handleWebChannelEvents(
      dependencies,
      policyFailureEvents(),
      {} as WebSocket,
      context,
      undefined,
      { streamId: 'stream-policy' },
      undefined,
      'model-policy',
      'client-policy',
    );

    const doneEvents = emitted.filter((event) => (event as { type?: string }).type === 'done');
    expect(doneEvents).toEqual([{
      type: 'done',
      client_msg_id: 'client-policy',
      error: '当前模型受策略限制，请切换其他模型继续。',
      runId: 'run-policy',
      failureKind: 'policy_rejection',
      recoveryAction: 'switch_model',
    }]);
    expect(dependencies.setIdempotency).toHaveBeenCalledWith(
      undefined,
      'client-policy',
      'failed',
      'stream-policy',
    );
  });
});
