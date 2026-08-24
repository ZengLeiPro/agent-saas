import type pg from 'pg';

import { LEGACY_TENANT_ID } from '../data/tenants/types.js';

type PgPoolClient = pg.PoolClient;

export async function applyPgEventStoreSchema(
  client: PgPoolClient,
  eventsTable: string,
  cursorsTable: string,
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${cursorsTable} (
      tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}',
      session_id TEXT NOT NULL,
      next_sequence BIGINT NOT NULL DEFAULT 1,
      PRIMARY KEY (tenant_id, session_id)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${eventsTable} (
      global_sequence BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      session_sequence BIGINT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      run_id TEXT,
      tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}', /* 旧事件缺 tenant 时回填 legacy tenant */
      timestamp TIMESTAMPTZ NOT NULL,
      event_json JSONB NOT NULL,
      UNIQUE(tenant_id, event_id),
      UNIQUE(tenant_id, session_id, session_sequence)
    )
  `);
  // PR 3 迁移：兼容旧库。不要在每次进程启动时无条件跑 ALTER TABLE；即使
  // IF NOT EXISTS 已命中，PostgreSQL 仍会申请强表锁，关机前遗留的长会话读取
  // 可能因此把 Server/Worker 的整个启动路径一起堵住。
  const existingColumns = new Set((await client.query<{ column_name: string }>(`
    SELECT attname AS column_name
    FROM pg_attribute
    WHERE attrelid = $1::regclass
      AND attnum > 0
      AND NOT attisdropped
  `, [eventsTable])).rows.map((row) => row.column_name));
  if (!existingColumns.has('tenant_id')) {
    await client.query(`
      ALTER TABLE ${eventsTable}
      ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}'
    `);
  }

  const cursorColumns = new Set((await client.query<{ column_name: string }>(`
    SELECT attname AS column_name
    FROM pg_attribute
    WHERE attrelid = $1::regclass
      AND attnum > 0
      AND NOT attisdropped
  `, [cursorsTable])).rows.map((row) => row.column_name));
  if (!cursorColumns.has('tenant_id')) {
    await client.query(`
      ALTER TABLE ${cursorsTable}
      ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}'
    `);
  }

  // 旧 schema 的 event_id 全局唯一、(session_id, sequence) 唯一及 cursor
  // session_id 主键都会阻断两个 tenant 使用相同业务 ID。按约束列精确识别并删除，
  // 避免依赖 PostgreSQL 自动生成且可能被截断的 constraint 名称；其他业务约束不动。
  await dropConstraintByColumns(client, eventsTable, ['event_id']);
  await dropConstraintByColumns(client, eventsTable, ['session_id', 'session_sequence']);
  await dropConstraintByColumns(client, cursorsTable, ['session_id']);

  // 兼容曾中断在“已删旧 PK、未建新唯一索引”的迁移：同一 tenant/session
  // 只保留一行，并保留最大的 next_sequence，避免 init 产生或放大重复 cursor。
  await client.query(`
    WITH ranked AS (
      SELECT ctid,
             ROW_NUMBER() OVER (
               PARTITION BY tenant_id, session_id
               ORDER BY next_sequence DESC, ctid
             ) AS row_number
      FROM ${cursorsTable}
    )
    DELETE FROM ${cursorsTable} cursor_row
    USING ranked
    WHERE cursor_row.ctid = ranked.ctid
      AND ranked.row_number > 1
  `);

  await ensureUniqueIndexByColumns(
    client,
    eventsTable,
    `${eventsTable}_tenant_event_id_key`,
    ['tenant_id', 'event_id'],
  );
  await ensureUniqueIndexByColumns(
    client,
    eventsTable,
    `${eventsTable}_tenant_session_sequence_key`,
    ['tenant_id', 'session_id', 'session_sequence'],
  );
  await ensureUniqueIndexByColumns(
    client,
    cursorsTable,
    `${cursorsTable}_tenant_session_key`,
    ['tenant_id', 'session_id'],
  );

  // 省略 tenant_id 的旧 writer 和历史 cursor 永远属于 LEGACY_TENANT_ID，不能根据
  // 同 session 的新事件“猜归属”。再按事件事实源为每个 tenant/session 独立补齐
  // cursor；重复 init 只会单调修正 next_sequence，不会插入重复行。
  await client.query(`
    INSERT INTO ${cursorsTable} (tenant_id, session_id, next_sequence)
    SELECT tenant_id, session_id, COALESCE(MAX(session_sequence), 0) + 1
    FROM ${eventsTable}
    GROUP BY tenant_id, session_id
    ON CONFLICT (tenant_id, session_id) DO UPDATE
    SET next_sequence = GREATEST(${cursorsTable}.next_sequence, EXCLUDED.next_sequence)
  `);
  // 保留 LEGACY default：rolling deploy 中旧 writer 仍可能省略 tenant_id。新代码
  // 始终显式写 tenant_id；default 只承接旧进程/旧数据，绝不作为新 API fallback。
  await client.query(`
    ALTER TABLE ${cursorsTable}
    ALTER COLUMN tenant_id SET DEFAULT '${LEGACY_TENANT_ID}'
  `);

  // tenant-scoped sequence 唯一索引已覆盖 session 顺序读取；event_json GIN
  // 历史上 idx_scan=0，也不再创建。
  // 旧库可能仍有 legacy ${eventsTable}_run_idx（早期为 run_id 单列），
  // init 阶段不碰它；新库只创建当前查询下推使用的 session_run_idx。
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${eventsTable}_session_run_idx
    ON ${eventsTable} (tenant_id, session_id, run_id, session_sequence)
    WHERE run_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${eventsTable}_type_idx
    ON ${eventsTable} (tenant_id, session_id, event_type, session_sequence)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${eventsTable}_tool_call_idx
    ON ${eventsTable} (tenant_id, (event_json->>'toolCallId'), session_id, session_sequence)
    WHERE event_json ? 'toolCallId'
  `);
  // PR 3：tenant_id 索引（按组织分页 / 计费 / 审计聚合时用）
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${eventsTable}_tenant_idx
    ON ${eventsTable} (tenant_id, timestamp DESC)
  `);
}

async function ensureUniqueIndexByColumns(
  client: PgPoolClient,
  table: string,
  indexName: string,
  columns: string[],
): Promise<void> {
  const result = await client.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_index index_row
      WHERE index_row.indrelid = $1::regclass
        AND index_row.indisunique
        AND index_row.indpred IS NULL
        AND index_row.indexprs IS NULL
        AND ARRAY(
          SELECT attribute.attname
          FROM unnest(index_row.indkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = index_row.indrelid
           AND attribute.attnum = key.attnum
          WHERE key.position <= index_row.indnkeyatts
          ORDER BY key.position
        ) = $2::text[]
    ) AS present
  `, [table, columns]);
  if (result.rows[0]?.present) return;
  const quotedIndex = `"${indexName.replaceAll('"', '""')}"`;
  await client.query(`CREATE UNIQUE INDEX ${quotedIndex} ON ${table} (${columns.join(', ')})`);
}

async function dropConstraintByColumns(
  client: PgPoolClient,
  table: string,
  columns: string[],
): Promise<void> {
  const result = await client.query<{ conname: string; columns: string[] }>(`
    SELECT constraint_row.conname,
           ARRAY(
             SELECT attribute.attname
             FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
             JOIN pg_attribute attribute
               ON attribute.attrelid = constraint_row.conrelid
              AND attribute.attnum = key.attnum
             ORDER BY key.position
           ) AS columns
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = $1::regclass
      AND constraint_row.contype IN ('p', 'u')
  `, [table]);
  for (const row of result.rows) {
    if (row.columns.length !== columns.length || row.columns.some((column, index) => column !== columns[index])) continue;
    const constraint = `"${row.conname.replaceAll('"', '""')}"`;
    await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
  }
}
