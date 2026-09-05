import { describe, expect, it, vi } from 'vitest';

import {
  cancelUnstartedDeliveryIntentsForInbox,
  getReplyRecoveryStateForInbox,
} from './deliveryClaims.js';

describe('getReplyRecoveryStateForInbox', () => {
  it.each(['none', 'unstarted', 'sent', 'unknown'] as const)(
    'returns the durable recovery classification %s',
    async recoveryState => {
      const query = vi.fn().mockResolvedValue({
        rows: [{ recovery_state: recoveryState }],
      });

      await expect(getReplyRecoveryStateForInbox(
        { query } as never,
        'gov_agent_dws_delivery_intents',
        'tenant-a',
        'inbox-a',
      )).resolves.toBe(recoveryState);

      const [sql, values] = query.mock.calls[0]!;
      expect(String(sql)).toContain("delivery_kind='front_reply'");
      expect(String(sql)).toContain("delivery_state='unknown'");
      expect(String(sql)).toContain("provider_attempt_phase='before_provider'");
      expect(String(sql)).toContain("provider_attempt_phase='provider_started'");
      expect(String(sql)).toContain("delivery_state='sent'");
      expect(String(sql)).toContain("LIKE 'ORG_AGENT_PROVIDER_AUTHORIZATION_%'");
      expect(values).toEqual(['tenant-a', 'inbox-a']);
    },
  );

  it('隔离无法证明未出站的 legacy delivery，而不是把它取消成安全未发送', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2 });

    await expect(cancelUnstartedDeliveryIntentsForInbox(
      { query } as never, 'deliveries', 'tenant-a', 'inbox-a', 'revoked',
    )).resolves.toBe(2);

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("provider_attempt_phase='before_provider'");
    expect(sql).toContain("THEN 'dead_letter' ELSE 'unknown'");
    expect(sql).toContain("delivery_state IN ('pending','sending')");
  });

  it('aggregate row 意外缺失时回退为 none', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(getReplyRecoveryStateForInbox(
      { query } as never,
      'gov_agent_dws_delivery_intents',
      'tenant-a',
      'inbox-a',
    )).resolves.toBe('none');
  });
});
