import { describe, expect, it, vi } from 'vitest';

import { getReplyRecoveryStateForInbox } from './deliveryClaims.js';

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
      expect(String(sql)).toContain("provider_started_at IS NOT NULL");
      expect(String(sql)).toContain("delivery_state='sent'");
      expect(String(sql)).toContain("NOT LIKE 'ORG_AGENT_PROVIDER_AUTHORIZATION_%'");
      expect(values).toEqual(['tenant-a', 'inbox-a']);
    },
  );

  it('fails closed to none when the aggregate row is unexpectedly absent', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(getReplyRecoveryStateForInbox(
      { query } as never,
      'gov_agent_dws_delivery_intents',
      'tenant-a',
      'inbox-a',
    )).resolves.toBe('none');
  });
});
