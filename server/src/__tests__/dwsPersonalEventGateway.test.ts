import { describe, expect, it } from 'vitest';

import { parseEventLine } from '../dws/personalEventGateway.js';

const event = {
  type: 'user_im_message_receive_at',
  event_id: 'event-1',
  conversation_id: 'cid-1',
  message_id: 'msg-1',
  sender_open_dingtalk_id: 'sender-1',
  content: '@销售数字员工 查一下进度',
  timestamp: 1786630000000,
};

describe('DWS Personal Stream event parser', () => {
  it('提取稳定路由字段并保留原始 payload', () => {
    expect(parseEventLine(JSON.stringify(event))).toEqual({
      type: event.type,
      eventId: event.event_id,
      conversationId: event.conversation_id,
      messageId: event.message_id,
      senderOpenDingtalkId: event.sender_open_dingtalk_id,
      content: event.content,
      timestamp: event.timestamp,
      raw: event,
    });
  });

  it('忽略日志、坏 JSON 和没有 event_id 的对象', () => {
    expect(parseEventLine('[event] ready')).toBeNull();
    expect(parseEventLine('{bad')).toBeNull();
    expect(parseEventLine(JSON.stringify({ type: event.type }))).toBeNull();
  });
});
