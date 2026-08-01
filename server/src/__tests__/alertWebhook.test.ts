import { describe, expect, it, vi } from 'vitest';

import { sendDingtalkAlertWebhook } from '../integrations/dingtalk/alertWebhook.js';

describe('sendDingtalkAlertWebhook', () => {
  const markdown = { title: 'agent-saas 告警', text: 'incident' };

  it('resolves only when DingTalk accepts the message', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errcode: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(sendDingtalkAlertWebhook('https://example.com/webhook', markdown, fetchImpl as any)).resolves.toBeUndefined();
  });

  it('rejects on HTTP or DingTalk API errors so the notifier can retry', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errcode: 310000, errmsg: 'invalid token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(sendDingtalkAlertWebhook('https://example.com/webhook', markdown, fetchImpl as any))
      .rejects.toThrow('errcode=310000');
  });

  it('rejects network errors so the notifier does not mark the alert as delivered', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });

    await expect(sendDingtalkAlertWebhook('https://example.com/webhook', markdown, fetchImpl as any))
      .rejects.toThrow('network down');
  });
});
