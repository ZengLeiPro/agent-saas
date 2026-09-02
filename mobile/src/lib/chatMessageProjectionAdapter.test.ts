import { expect, it } from 'vitest';
import { createActivityMessageProjectionState, type WsEvent } from '@agent/shared';
import { projectMobileChatEvent } from './chatMessageProjectionAdapter';

it('Mobile adapter renders shared canonical block identity', () => {
  const event = { type: 'block_start', blockType: 'thinking', projection: { eventId: 'e1', domain: 'message', runId: 'r1', messageId: 'm1', blockId: 'b1' } } as WsEvent;
  expect(projectMobileChatEvent(createActivityMessageProjectionState(), event).messages).toEqual([
    expect.objectContaining({ id: 'b1', type: 'thinking', streaming: true }),
  ]);
});
