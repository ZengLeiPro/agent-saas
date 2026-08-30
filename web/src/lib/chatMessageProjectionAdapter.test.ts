import { expect, it } from 'vitest';
import { createActivityMessageProjectionState, type WsEvent } from '@agent/shared';
import { projectWebChatEvent } from './chatMessageProjectionAdapter';

it('Web adapter renders shared canonical block identity', () => {
  const event = { type: 'block_start', blockType: 'text', projection: { eventId: 'e1', domain: 'message', runId: 'r1', messageId: 'm1', blockId: 'b1' } } as WsEvent;
  expect(projectWebChatEvent(createActivityMessageProjectionState(), event).messages).toEqual([
    expect.objectContaining({ id: 'b1', type: 'text', streaming: true }),
  ]);
});
