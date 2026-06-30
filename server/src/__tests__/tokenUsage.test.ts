import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getBusinessDb, closeBusinessDb, __resetBusinessDbForTest } from '../data/db/business.js';
import { runBusinessMigrations } from '../data/db/migrations.js';
import { createTokenUsageStore, formatBeijingDate, formatBeijingMinute } from '../data/usage/store.js';

describe('token usage store', () => {
  const cleanupDirs = new Set<string>();
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'token-usage-test-'));
    cleanupDirs.add(dataDir);
    __resetBusinessDbForTest();
  });

  afterEach(async () => {
    __resetBusinessDbForTest();
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('runs migrations idempotently', () => {
    const db = getBusinessDb(dataDir);
    const r1 = runBusinessMigrations(db);
    expect(r1.applied.length).toBeGreaterThan(0);
    const r2 = runBusinessMigrations(db);
    expect(r2.applied.length).toBe(0);
    closeBusinessDb();
  });

  it('UPSERT accumulates across multiple recordResult calls', () => {
    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    const store = createTokenUsageStore(db);

    const ts = Date.parse('2026-05-16T08:00:00+08:00');

    store.recordResult({
      username: 'zenglei',
      tenantId: 'kaiyan',
      channel: 'web',
      modelUsage: {
        'claude-opus-4-6': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 200,
          costUSD: 0.012,
        },
      },
      occurredAtMs: ts,
    });

    store.recordResult({
      username: 'zenglei',
      tenantId: 'kaiyan',
      channel: 'web',
      modelUsage: {
        'claude-opus-4-6': {
          inputTokens: 30,
          outputTokens: 70,
          cacheReadInputTokens: 500,
          cacheCreationInputTokens: 0,
          costUSD: 0.008,
        },
      },
      occurredAtMs: ts + 60_000,
    });

    const rows = store.listByDate('2026-05-16');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      username: 'zenglei',
      tenantId: 'kaiyan',
      model: 'claude-opus-4-6',
      channel: 'web',
      inputTokens: 130,
      outputTokens: 120,
      cacheReadTokens: 1500,
      cacheCreationTokens: 200,
      // 本地 pricing.ts 算（claude-opus-4-6: in $5/M, out $25/M, cacheRead $0.5/M, cacheCreation 1h $10/M）
      // = 5*130 + 25*120 + 0.5*1500 + 10*200 = 650 + 3000 + 750 + 2000 = 6400 micro USD
      // 不再用 SDK 给的 costUSD 字段
      costUsdMicro: 6_400,
      turnCount: 2,
    });
  });

  it('separates rows by model and channel', () => {
    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    const store = createTokenUsageStore(db);

    const ts = Date.parse('2026-05-16T08:00:00+08:00');

    store.recordResult({
      username: 'zenglei',
      tenantId: 'kaiyan',
      channel: 'web',
      modelUsage: {
        'claude-opus-4-6': { inputTokens: 100, outputTokens: 50, costUSD: 0.01 },
        'gpt-5.5': { inputTokens: 200, outputTokens: 80, costUSD: 0.005 },
      },
      occurredAtMs: ts,
    });

    store.recordResult({
      username: 'zenglei',
      tenantId: 'kaiyan',
      channel: 'cron',
      modelUsage: {
        'claude-opus-4-6': { inputTokens: 10, outputTokens: 5, costUSD: 0.001 },
      },
      occurredAtMs: ts,
    });

    const rows = store.listByDate('2026-05-16');
    expect(rows).toHaveLength(3);

    const byKey = new Map(rows.map(r => [`${r.model}|${r.channel}`, r]));
    expect(byKey.get('claude-opus-4-6|web')?.inputTokens).toBe(100);
    expect(byKey.get('claude-opus-4-6|cron')?.inputTokens).toBe(10);
    expect(byKey.get('gpt-5.5|web')?.inputTokens).toBe(200);
  });

  it('formatBeijingDate converts UTC ms to UTC+8 date', () => {
    // UTC 2026-05-16 00:00:00 = 北京 2026-05-16 08:00:00
    expect(formatBeijingDate(Date.UTC(2026, 4, 16, 0, 0, 0))).toBe('2026-05-16');
    // UTC 2026-05-15 16:00:00 = 北京 2026-05-16 00:00:00
    expect(formatBeijingDate(Date.UTC(2026, 4, 15, 16, 0, 0))).toBe('2026-05-16');
    // UTC 2026-05-15 15:59:59 = 北京 2026-05-15 23:59:59
    expect(formatBeijingDate(Date.UTC(2026, 4, 15, 15, 59, 59))).toBe('2026-05-15');
  });

  it('formatBeijingMinute converts UTC ms to UTC+8 minute', () => {
    expect(formatBeijingMinute(Date.UTC(2026, 4, 15, 16, 1, 30))).toBe('2026-05-16T00:01');
  });

  it('listByUsername filters by date range', () => {
    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    const store = createTokenUsageStore(db);

    const day = (s: string) => Date.parse(`${s}T08:00:00+08:00`);
    for (const d of ['2026-05-10', '2026-05-12', '2026-05-15']) {
      store.recordResult({
        username: 'zenglei',
        tenantId: 'kaiyan',
        channel: 'web',
        modelUsage: { 'claude-opus-4-6': { inputTokens: 100, outputTokens: 50, costUSD: 0.01 } },
        occurredAtMs: day(d),
      });
    }

    const all = store.listByUsername('zenglei');
    expect(all).toHaveLength(3);

    const filtered = store.listByUsername('zenglei', '2026-05-11', '2026-05-13');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].date).toBe('2026-05-12');
  });

  it('rebuild state read/write roundtrip', () => {
    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    const store = createTokenUsageStore(db);

    expect(store.getRebuildState()).toBeNull();

    const now = Date.now();
    store.setRebuildState({
      lastRebuildAtMs: now,
      lastFullScanMs: now,
      jsonlMaxMtimeMs: now,
      totalFilesScanned: 3000,
      totalRowsBuilt: 600,
    });

    const got = store.getRebuildState();
    expect(got).toEqual({
      lastRebuildAtMs: now,
      lastFullScanMs: now,
      jsonlMaxMtimeMs: now,
      totalFilesScanned: 3000,
      totalRowsBuilt: 600,
    });
  });

  it('upsertRaw allows arbitrary turn delta (回填路径)', () => {
    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    const store = createTokenUsageStore(db);

    const ts = Date.parse('2026-05-16T08:00:00+08:00');
    store.upsertRaw({
      date: '2026-05-16',
      username: 'admin',
      tenantId: 'kaiyan',
      model: 'claude-opus-4-6',
      channel: 'web',
      inputTokens: 10_000,
      outputTokens: 5_000,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 2_000,
      costUsdMicro: 0,
      turnDelta: 25,
      occurredAtMs: ts,
    });

    const rows = store.listByDate('2026-05-16');
    expect(rows[0].turnCount).toBe(25);
    expect(rows[0].inputTokens).toBe(10_000);
  });

  it('clearAll wipes table', () => {
    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    const store = createTokenUsageStore(db);

    store.recordResult({
      username: 'a',
      tenantId: 'kaiyan',
      channel: 'web',
      modelUsage: { 'm': { inputTokens: 1, outputTokens: 1 } },
      occurredAtMs: Date.now(),
    });
    expect(store.listByDate(formatBeijingDate(Date.now()))).toHaveLength(1);

    store.clearAll();
    expect(store.listByDate(formatBeijingDate(Date.now()))).toHaveLength(0);
  });
});
