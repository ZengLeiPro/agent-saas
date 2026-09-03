import { describe, expect, it } from 'vitest';
import type { MessageItem } from '@agent/shared';
import { replaceRetryBubble } from './retryBubbleTransition';

const failedIntent: MessageItem = {
  id: 'bubble-1',
  type: 'user',
  content: 'hello',
  status: 'failed',
  timestamp: 1,
  clientMsgId: 'stable-client-id',
  attachments: [{ name: 'proof.txt', attachmentId: 'attachment-1' }],
};

describe('ACK timeout retry bubble transition', () => {
  it('离线等前置失败未进入 transition 时，原 intent 完整保留', () => {
    const messages = [failedIntent];
    expect(messages).toEqual([failedIntent]);
  });

  it('新 attempt 开始后原位复用 bubble 与 clientMsgId', () => {
    const result = replaceRetryBubble([failedIntent], failedIntent.id, {
      type: 'user',
      content: 'hello',
      status: 'pending',
      timestamp: 2,
      clientMsgId: 'stable-client-id',
      attachments: failedIntent.attachments,
    });

    expect(result).not.toBeNull();
    expect(result?.index).toBe(0);
    expect(result?.messages).toEqual([{
      ...failedIntent,
      status: 'pending',
      timestamp: 2,
    }]);
  });
});
