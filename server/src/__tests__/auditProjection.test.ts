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
  });

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
      `SELECT id, session_id, run_id, tool_call_id, tool_id, tool_name, risk,
              approval_id, authorization_source, authorization_json,
              execution_target, status, duration_ms, execution_invocations_json, error
       FROM tool_audit WHERE id = $1;`,
      [evtId],
    )).getRowObjects();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(evtId);
    expect(row.session_id).toBe(SESSION_A);
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

  it('tickFile 文件回退（size < watermark）→ clear 该 session + 全量重投 + reset=true', async () => {
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
