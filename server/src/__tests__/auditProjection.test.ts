/**
 * AuditProjection (DuckDB) tests
 *
 * 覆盖：
 *   - initialize() 是 idempotent，可重复调用
 *   - tickFile 投影 tool_audit、过滤非 tool_audit 事件、字段映射正确
 *   - tickFile 增量：第二次 tick 只插入新增事件
 *   - tickFile 文件回退：clear 该 session 历史 + 全量重投
 *   - tickFile 文件不存在：bytesRead=0、不报错
 *   - tick() 扫描 root 多目录 + 多文件
 *
 * 用 in-memory DuckDB（path=`:memory:`）+ tmpdir 假 ALLOWED_ROOT；不依赖 server。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, appendFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import {
  AuditProjection,
  createAuditProjection,
  RUNTIME_EVENTS_SUFFIX,
} from '../runtime/auditProjection.js';
import type { PlatformEvent } from '../runtime/types.js';

const SESSION_A = '11111111-aaaa-4bbb-8ccc-dddddddddddd';
const SESSION_B = '22222222-aaaa-4bbb-8ccc-dddddddddddd';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function toolAuditLine(overrides: Partial<Extract<PlatformEvent, { type: 'tool_audit' }>>): string {
  const base = {
    id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: '2026-06-07T10:00:00.000Z',
    type: 'tool_audit' as const,
    runId: 'run-A',
    sessionId: SESSION_A,
    toolCallId: 'call-1',
    toolId: 'MemorySearch',
    toolName: 'MemorySearch',
    risk: 'safe' as const,
    authorization: { approved: true, source: 'policy_auto' as const },
    executionTarget: 'server-local' as const,
    status: 'success' as const,
    durationMs: 12,
    ...overrides,
  };
  return JSON.stringify(base) + '\n';
}

function nonAuditLine(): string {
  return JSON.stringify({
    id: 'noise-1',
    timestamp: '2026-06-07T09:59:00.000Z',
    type: 'run_started',
    runId: 'run-A',
    sessionId: SESSION_A,
    model: 'gpt-5.5',
    channel: 'web',
  }) + '\n';
}

describe('AuditProjection (DuckDB)', () => {
  const cleanupDirs = new Set<string>();
  let instance: DuckDBInstance;
  let db: DuckDBConnection;
  let root: string;
  let projection: AuditProjection;

  beforeEach(async () => {
    instance = await DuckDBInstance.create(':memory:');
    db = await instance.connect();
    root = await mkdtemp(join(tmpdir(), 'audit-proj-'));
    cleanupDirs.add(root);
    projection = createAuditProjection({ db, root });
    await projection.initialize();
  }, 30_000);

  afterEach(async () => {
    try { db.closeSync(); } catch { /* ignore */ }
    try { instance.closeSync(); } catch { /* ignore */ }
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  async function seedFile(sessionId: string, lines: string[]): Promise<string> {
    const dir = join(root, `proj-${sessionId.slice(0, 8)}`);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${sessionId}${RUNTIME_EVENTS_SUFFIX}`);
    await writeFile(filePath, lines.join(''));
    return filePath;
  }

  async function rowCount(table: string): Promise<number> {
    const r = await db.runAndReadAll(`SELECT COUNT(*) AS c FROM ${table};`);
    const rows = r.getRowObjects();
    const v = rows[0]?.c;
    return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  }

  it('initialize() 可重复调用，schema 已就绪', async () => {
    // 再调用一次应当不抛
    await projection.initialize();
    await projection.initialize();
    // 表与索引存在 → COUNT 不报错
    expect(await rowCount('tool_audit')).toBe(0);
    expect(await rowCount('projection_watermark')).toBe(0);
  });

  it('旧 schema 无 provenance 时清空投影与 watermark，全量重建且迁移幂等', async () => {
    const filePath = await seedFile(SESSION_A, [toolAuditLine({
      id: 'rebuilt-event', tenantId: TENANT_A, sessionId: SESSION_A,
    })]);
    await db.run('DROP TABLE tool_audit;');
    await db.run(`CREATE TABLE tool_audit (
      id VARCHAR PRIMARY KEY, timestamp TIMESTAMP NOT NULL, session_id VARCHAR NOT NULL,
      run_id VARCHAR NOT NULL, tenant_id VARCHAR NOT NULL DEFAULT 'legacy',
      tool_call_id VARCHAR NOT NULL, tool_id VARCHAR NOT NULL, tool_name VARCHAR NOT NULL,
      skill_name VARCHAR, risk VARCHAR NOT NULL, approval_id VARCHAR,
      authorization_source VARCHAR NOT NULL, authorization_json VARCHAR NOT NULL,
      execution_target VARCHAR NOT NULL, status VARCHAR NOT NULL, duration_ms BIGINT NOT NULL,
      execution_invocations_json VARCHAR, error VARCHAR
    );`);
    await db.run(`INSERT INTO tool_audit VALUES (
      'unattributed-event', CAST('2026-06-07T10:00:00Z' AS TIMESTAMP), '${SESSION_A}', 'run-legacy',
      '${TENANT_A}', 'call-legacy', 'Read', 'Read', NULL, 'safe', NULL,
      'policy_auto', '{"approved":true,"source":"policy_auto"}', 'server-local',
      'success', 1, NULL, NULL
    );`);
    await db.run(
      `INSERT INTO projection_watermark (file_path, byte_offset, updated_at, tenant_ids_json)
       VALUES ($1, 999, current_timestamp, $2);`,
      [filePath, JSON.stringify([TENANT_A])],
    );

    await projection.initialize();
    expect(await rowCount('tool_audit')).toBe(0);
    expect(await rowCount('projection_watermark')).toBe(0);
    await projection.initialize();
    expect(await rowCount('tool_audit')).toBe(0);

    const info = (await db.runAndReadAll(`PRAGMA table_info('tool_audit');`)).getRowObjects();
    expect(info.filter((row) => row.pk).map((row) => row.name).sort()).toEqual(['id', 'tenant_id']);
    expect(info.find((row) => row.name === 'source_file_path')?.notnull).toBe(true);

    const result = await projection.tickFile(filePath);
    expect(result.eventsInserted).toBe(1);
    const rows = (await db.runAndReadAll(
      `SELECT id, source_file_path FROM tool_audit;`,
    )).getRowObjects();
    expect(rows.map((row) => [row.id, row.source_file_path])).toEqual([
      ['rebuilt-event', filePath],
    ]);
  });

  it('tickFile 投影 tool_audit、过滤非 tool_audit、字段映射正确', async () => {
    const evtId = 'evt-fix-001';
    const filePath = await seedFile(SESSION_A, [
      nonAuditLine(),
      toolAuditLine({
        id: evtId,
        toolName: 'Write',
        toolId: 'Write',
        risk: 'workspace_write',
        approvalId: 'apv-9',
        authorization: { approved: true, source: 'human_approval', approvalId: 'apv-9' },
        executionTarget: 'server-container',
        durationMs: 240,
        executionInvocations: [{
          provider: 'server-container',
          operation: 'writeFile',
          containerName: 'sess-x',
          status: 'success',
        }] as Extract<PlatformEvent, { type: 'tool_audit' }>['executionInvocations'],
      }),
    ]);

    const r = await projection.tickFile(filePath);
    expect(r.eventsInserted).toBe(1);
    expect(r.reset).toBe(false);
    expect(r.bytesRead).toBeGreaterThan(0);

    const rows = (await db.runAndReadAll(
      `SELECT id, session_id, run_id, source_file_path, tool_call_id, tool_id, tool_name, risk,
              approval_id, authorization_source, authorization_json,
              execution_target, status, duration_ms, execution_invocations_json, error
       FROM tool_audit WHERE id = $1;`,
      [evtId],
    )).getRowObjects();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(evtId);
    expect(row.session_id).toBe(SESSION_A);
    expect(row.source_file_path).toBe(filePath);
    expect(row.tool_name).toBe('Write');
    expect(row.risk).toBe('workspace_write');
    expect(row.approval_id).toBe('apv-9');
    expect(row.authorization_source).toBe('human_approval');
    expect(JSON.parse(String(row.authorization_json))).toEqual({
      approved: true, source: 'human_approval', approvalId: 'apv-9',
    });
    expect(row.execution_target).toBe('server-container');
    expect(row.status).toBe('success');
    expect(Number(row.duration_ms)).toBe(240);
    expect(JSON.parse(String(row.execution_invocations_json))[0].operation).toBe('writeFile');
    expect(row.error).toBeNull();
  });

  it('相同 event id 在不同 tenant 下均保留', async () => {
    const sharedEventId = 'evt-cross-tenant';
    const fileA = await seedFile(SESSION_A, [toolAuditLine({
      id: sharedEventId,
      tenantId: TENANT_A,
      sessionId: SESSION_A,
      toolCallId: 'call-tenant-a',
    })]);
    const fileB = await seedFile(SESSION_B, [toolAuditLine({
      id: sharedEventId,
      tenantId: TENANT_B,
      sessionId: SESSION_B,
      toolCallId: 'call-tenant-b',
    })]);

    await projection.tickFile(fileA);
    await projection.tickFile(fileB);

    const rows = (await db.runAndReadAll(
      `SELECT tenant_id, id, tool_call_id FROM tool_audit WHERE id = $1 ORDER BY tenant_id;`,
      [sharedEventId],
    )).getRowObjects();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.tenant_id, row.tool_call_id])).toEqual([
      [TENANT_A, 'call-tenant-a'],
      [TENANT_B, 'call-tenant-b'],
    ]);
  });

  it('tickFile 增量：第二次 tick 只插入新增事件', async () => {
    const filePath = await seedFile(SESSION_A, [
      toolAuditLine({ id: 'evt-1' }),
      toolAuditLine({ id: 'evt-2' }),
    ]);

    const r1 = await projection.tickFile(filePath);
    expect(r1.eventsInserted).toBe(2);
    const after1 = await rowCount('tool_audit');
    expect(after1).toBe(2);

    // 追加一条新事件
    await appendFile(filePath, toolAuditLine({ id: 'evt-3', toolCallId: 'call-3' }));
    const r2 = await projection.tickFile(filePath);
    expect(r2.eventsInserted).toBe(1);
    expect(r2.reset).toBe(false);
    expect(await rowCount('tool_audit')).toBe(3);

    // 再 tick 无变化 → 不该再插入
    const r3 = await projection.tickFile(filePath);
    expect(r3.eventsInserted).toBe(0);
    expect(r3.bytesRead).toBe(0);
  });

  it('tickFile 文件回退（size < watermark）→ clear 该源文件 + 全量重投 + reset=true', async () => {
    const filePath = await seedFile(SESSION_A, [
      toolAuditLine({ id: 'evt-pre-1' }),
      toolAuditLine({ id: 'evt-pre-2' }),
    ]);
    await projection.tickFile(filePath);
    expect(await rowCount('tool_audit')).toBe(2);

    // 模拟文件被截断 + 写入完全不同的内容（同一 session）
    await truncate(filePath, 0);
    await writeFile(filePath, toolAuditLine({ id: 'evt-post-1' }));

    const r = await projection.tickFile(filePath);
    expect(r.reset).toBe(true);
    expect(r.eventsInserted).toBe(1);

    const rows = (await db.runAndReadAll(
      `SELECT id FROM tool_audit ORDER BY id;`,
    )).getRowObjects();
    expect(rows.map((row) => row.id)).toEqual(['evt-post-1']);
  });

  it('同 tenant + sessionId 的不同目录文件：A reset 不删 B，B 无需重投', async () => {
    const sharedSession = '33333333-aaaa-4bbb-8ccc-dddddddddddd';
    const dirA = join(root, 'source-a');
    const dirB = join(root, 'source-b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = join(dirA, `${sharedSession}${RUNTIME_EVENTS_SUFFIX}`);
    const fileB = join(dirB, `${sharedSession}${RUNTIME_EVENTS_SUFFIX}`);
    await writeFile(fileA, [
      toolAuditLine({ id: 'a-old-1', tenantId: TENANT_A, sessionId: sharedSession }),
      toolAuditLine({ id: 'a-old-2', tenantId: TENANT_A, sessionId: sharedSession }),
    ].join(''));
    await writeFile(fileB, toolAuditLine({
      id: 'b-keep', tenantId: TENANT_A, sessionId: sharedSession,
    }));
    await projection.tickFile(fileA);
    await projection.tickFile(fileB);

    await truncate(fileA, 0);
    await writeFile(fileA, toolAuditLine({
      id: 'a-new', tenantId: TENANT_A, sessionId: sharedSession,
    }));
    const resultA = await projection.tickFile(fileA);
    const resultB = await projection.tickFile(fileB);

    expect(resultA.reset).toBe(true);
    expect(resultB).toEqual({ bytesRead: 0, eventsInserted: 0, reset: false });
    const rows = (await db.runAndReadAll(
      `SELECT id, source_file_path FROM tool_audit
        WHERE tenant_id = $1 AND session_id = $2 ORDER BY id;`,
      [TENANT_A, sharedSession],
    )).getRowObjects();
    expect(rows.map((row) => [row.id, row.source_file_path])).toEqual([
      ['a-new', fileA],
      ['b-keep', fileB],
    ]);
  });

  it('tickFile 文件不存在 → bytesRead=0、eventsInserted=0、不抛错', async () => {
    const filePath = join(root, 'absent', `${SESSION_A}${RUNTIME_EVENTS_SUFFIX}`);
    const r = await projection.tickFile(filePath);
    expect(r).toEqual({ bytesRead: 0, eventsInserted: 0, reset: false });
    expect(await rowCount('tool_audit')).toBe(0);
  });

  it('tick() 扫 root 下多个项目目录 + 多个 runtime-events 文件', async () => {
    await seedFile(SESSION_A, [
      toolAuditLine({ id: 'a-1', sessionId: SESSION_A }),
      toolAuditLine({ id: 'a-2', sessionId: SESSION_A, runId: 'run-A2' }),
    ]);
    await seedFile(SESSION_B, [
      toolAuditLine({ id: 'b-1', sessionId: SESSION_B, runId: 'run-B' }),
    ]);
    // noise：非 runtime-events 文件不应被扫
    await writeFile(join(root, `noise.txt`), 'ignore me');

    const stats = await projection.tick();
    expect(stats.filesScanned).toBe(2);
    expect(stats.filesProjected).toBe(2);
    expect(stats.eventsInserted).toBe(3);
    expect(stats.errors).toBe(0);
    expect(await rowCount('tool_audit')).toBe(3);

    const sessions = (await db.runAndReadAll(
      `SELECT DISTINCT session_id FROM tool_audit ORDER BY session_id;`,
    )).getRowObjects();
    expect(sessions.map((r) => r.session_id).sort()).toEqual([SESSION_A, SESSION_B].sort());
  });

  it('clear() 清空 audit + watermark', async () => {
    const filePath = await seedFile(SESSION_A, [toolAuditLine({ id: 'evt-c' })]);
    await projection.tickFile(filePath);
    expect(await rowCount('tool_audit')).toBe(1);
    expect(await rowCount('projection_watermark')).toBe(1);

    await projection.clear();
    expect(await rowCount('tool_audit')).toBe(0);
    expect(await rowCount('projection_watermark')).toBe(0);
  });
});
