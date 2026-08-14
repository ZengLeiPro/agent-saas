import { describe, expect, it, vi } from 'vitest';

import { PgGovernanceMigrationRunner } from '../data/governance-schema/migrations.js';

describe('Governance schema v20 Agent DWS message migration', () => {
  it('创建 durable inbox/binding 表、payload/state/FK/UQ 约束与 claim/conversation 索引', async () => {
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('SELECT version FROM')) {
        return { rows: Array.from({ length: 19 }, (_, index) => ({ version: index + 1 })) };
      }
      return { rows: [], rowCount: values?.[0] === 20 ? 1 : 0 };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: async () => client };

    await new PgGovernanceMigrationRunner(pool as never, 'test').run();

    const sql = query.mock.calls.map(call => String(call[0])).join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_agent_dws_event_inbox');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_agent_dws_conversation_bindings');
    expect(sql).toContain('test_agent_dws_accounts_tenant_account_unique_idx');
    expect(sql).toContain('FOREIGN KEY (tenant_id,account_id)');
    expect(sql).toContain(
      'REFERENCES test_agent_dws_accounts(tenant_id,account_id) ON DELETE CASCADE',
    );
    expect(sql).toContain("state IN ('pending','processing','retry_wait','reply_pending','completed','dead_letter')");
    expect(sql).toContain('UNIQUE (account_id,event_id)');
    expect(sql).toContain("CHECK (jsonb_typeof(payload_json) = 'object')");
    expect(sql).toContain('CHECK (octet_length(payload_json::text) <= 262144)');
    expect(sql).toContain('reply_started_at TIMESTAMPTZ');
    expect(sql).toContain('test_agent_dws_event_inbox_claim_idx');
    expect(sql).toContain('test_agent_dws_event_inbox_account_conversation_idx');
    expect(sql).toContain('UNIQUE (account_id,conversation_id)');
    expect(sql).toContain('UNIQUE (session_id)');
    expect(query.mock.calls.some(call => (
      String(call[0]) === 'INSERT INTO test_governance_schema_versions (version) VALUES ($1)'
      && call[1]?.[0] === 20
    ))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('Governance schema v21 Agent DWS peer binding migration', () => {
  it('adds the durable direct-message peer identity used to suppress self echoes', async () => {
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('SELECT version FROM')) {
        return { rows: Array.from({ length: 20 }, (_, index) => ({ version: index + 1 })) };
      }
      return { rows: [], rowCount: values?.[0] === 21 ? 1 : 0 };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: async () => client };

    await new PgGovernanceMigrationRunner(pool as never, 'test').run();

    const sql = query.mock.calls.map(call => String(call[0])).join('\n');
    expect(sql).toContain('ALTER TABLE test_agent_dws_conversation_bindings');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS peer_open_dingtalk_id TEXT');
    expect(query.mock.calls.some(call => (
      String(call[0]) === 'INSERT INTO test_governance_schema_versions (version) VALUES ($1)'
      && call[1]?.[0] === 21
    ))).toBe(true);
  });
});
