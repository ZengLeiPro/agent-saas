import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { DerivedContextStore } from '../src/context/derived/store.js';

const DEFAULT_CONSUMER_ID = 'context-deterministic-projector-v1';

interface ReplayArgs {
  tenantId: string;
  tablePrefix: string;
  consumerId: string;
  expectedCursorSeq?: string;
  apply: boolean;
  confirmTenantId?: string;
}

export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const values = new Map<string, string>();
  let apply = false;
  for (const argument of argv) {
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw new Error(`未知参数：${argument}`);
    values.set(match[1]!, match[2]!);
  }
  const tenantId = required(values, 'tenant');
  const tablePrefix = required(values, 'table-prefix');
  const consumerId = values.get('consumer') ?? DEFAULT_CONSUMER_ID;
  const expectedCursorSeq = values.get('expected-cursor');
  if (expectedCursorSeq !== undefined && !/^\d+$/.test(expectedCursorSeq)) {
    throw new Error('--expected-cursor 必须是非负整数');
  }
  return {
    tenantId,
    tablePrefix,
    consumerId,
    ...(expectedCursorSeq !== undefined ? { expectedCursorSeq } : {}),
    apply,
    ...(values.has('confirm-tenant') ? { confirmTenantId: values.get('confirm-tenant')! } : {}),
  };
}

async function main(): Promise<void> {
  const args = parseReplayArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const store = new DerivedContextStore({
    pool,
    tablePrefix: args.tablePrefix,
    roleGate: { mayCorrectOrganization: async () => false },
  });
  try {
    const current = await pool.query(`SELECT cursor_seq,status,lease_owner,lease_expires_at,updated_at
      FROM ${store.tables.consumers} WHERE tenant_id=$1 AND consumer_id=$2`,
    [args.tenantId, args.consumerId]);
    const row = current.rows[0];
    if (!row) throw new Error('未找到指定租户的派生消费者');
    const cursorSeq = String(row.cursor_seq);
    const plan = {
      mode: args.apply ? 'apply' : 'dry-run',
      tenantId: args.tenantId,
      consumerId: args.consumerId,
      cursorSeq,
      status: row.status,
      leaseActive: Boolean(row.lease_owner && row.lease_expires_at
        && new Date(row.lease_expires_at).getTime() > Date.now()),
      action: '将该租户消费者游标重置为 0；保留派生行、人工纠正与审核，随后由 worker 幂等重放',
    };
    console.log(JSON.stringify(plan, null, 2));
    if (!args.apply) return;
    if (args.confirmTenantId !== args.tenantId) {
      throw new Error('--apply 必须同时提供与 --tenant 完全一致的 --confirm-tenant');
    }
    if (args.expectedCursorSeq === undefined) {
      throw new Error('--apply 必须提供 dry-run 看到的 --expected-cursor');
    }
    const result = await store.resetConsumerForReplay({
      tenantId: args.tenantId,
      consumerId: args.consumerId,
      expectedCursorSeq: args.expectedCursorSeq,
    });
    console.log(JSON.stringify({ applied: true, ...result, nextCursorSeq: '0' }, null, 2));
  } finally {
    await pool.end();
  }
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`缺少 --${key}=...`);
  return value;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
