#!/usr/bin/env tsx
/**
 * 以 runtime_runs 为权威真源修复会话目录状态。
 *
 * 默认只读预演。只有 --execute 会更新 transcript .meta.json 与 runtime_sessions
 * 中过期的 runtimeStatus；不会删除会话或 run。
 */
import { resolve } from 'node:path';

import pg from 'pg';

import { loadAppConfig } from '../src/app/config.js';
import { updateSessionMeta } from '../src/data/transcripts/meta.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../src/data/transcripts/projectKey.js';
import { PgSessionLock } from '../src/runtime/pgSessionLock.js';
import {
  PgRuntimeSessionStatusReconciliationStore,
  RuntimeSessionStatusReconciler,
  runtimeSessionStatusForTerminalRun,
} from '../src/runtime/runtimeSessionStatusReconciler.js';
import { scanRuntimeSessionMetaFiles } from '../src/runtime/sessionProjectionStore.js';
import type { RuntimeSessionStatus } from '../src/runtime/sessionCatalog.js';

const { Pool } = pg;

interface Options {
  execute: boolean;
  root: string;
  connectionString?: string;
  tablePrefix: string;
  limit: number;
}

function pickArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found?.slice(prefix.length);
}

function parseOptions(): Options {
  const config = loadAppConfig(process.cwd());
  const runtimePg =
    config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore : undefined;
  const rawLimit = Number(pickArg('--limit') ?? 10_000);
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 10_000) {
    throw new Error('--limit 必须是 1 到 10000 之间的整数');
  }
  return {
    execute: process.argv.includes('--execute'),
    root: resolve(pickArg('--root') ?? AGENT_LEGACY_TRANSCRIPTS_ROOT),
    connectionString: pickArg('--connection-string') ?? runtimePg?.connectionString,
    tablePrefix: pickArg('--table-prefix') ?? runtimePg?.tablePrefix ?? 'runtime',
    limit: rawLimit,
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  if (!options.connectionString) throw new Error('缺少 PG connection string');
  if (options.execute && options.root !== resolve(AGENT_LEGACY_TRANSCRIPTS_ROOT)) {
    throw new Error(`--execute 只允许规范 transcript 根目录：${AGENT_LEGACY_TRANSCRIPTS_ROOT}`);
  }
  console.log(
    `[start] mode=${options.execute ? 'EXECUTE' : 'DRY-RUN'} root=${options.root} tablePrefix=${options.tablePrefix} limit=${options.limit}`,
  );

  const pool = new Pool({ connectionString: options.connectionString });
  const store = new PgRuntimeSessionStatusReconciliationStore({
    pool,
    sessionsTable: `${options.tablePrefix}_sessions`,
    runsTable: `${options.tablePrefix}_runs`,
  });
  let sessionLock: PgSessionLock | undefined;
  try {
    const candidates = await store.listCandidates(options.limit);
    const grouped = new Map<string, number>();
    for (const candidate of candidates) {
      const target = runtimeSessionStatusForTerminalRun(candidate.kind, candidate.latestRunStatus);
      const key = `${candidate.kind}:${candidate.latestRunStatus}->${target}`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
      console.log(
        '[candidate]',
        JSON.stringify({
          sessionId: candidate.sessionId,
          tenantId: candidate.tenantId,
          username: candidate.username,
          title: candidate.title,
          kind: candidate.kind,
          projectionStatus: candidate.projectionStatus,
          metaStatus: candidate.metaStatus,
          latestRunId: candidate.latestRunId,
          latestRunStatus: candidate.latestRunStatus,
          latestRunUpdatedAt: candidate.latestRunUpdatedAt,
          target,
        }),
      );
    }
    console.log(
      '[plan]',
      JSON.stringify({
        candidates: candidates.length,
        truncated: candidates.length === options.limit,
        groups: Object.fromEntries([...grouped.entries()].sort()),
      }),
    );
    if (!options.execute) {
      console.log('[done] 当前仅预演；传入 --execute 才会同时修复 transcript meta 与 PG 投影。');
      return;
    }

    const scan = await scanRuntimeSessionMetaFiles(options.root);
    const transcriptBySessionId = new Map(
      scan.files.map((file) => [file.sessionId, file.transcriptPath]),
    );
    sessionLock = new PgSessionLock({
      pool,
      tablePrefix: options.tablePrefix,
      mode: loadAppConfig(process.cwd()).runtimeScheduler?.sessionLockMode ?? 'dual',
    });
    await sessionLock.init();
    const updateMetaStatus = async (
      sessionId: string,
      status: RuntimeSessionStatus,
    ): Promise<boolean> => {
      const transcriptPath = transcriptBySessionId.get(sessionId);
      if (!transcriptPath) return false;
      return (await updateSessionMeta(transcriptPath, { runtimeStatus: status })) !== null;
    };
    const reconciler = new RuntimeSessionStatusReconciler({
      store,
      sessionLock,
      updateMetaStatus,
    });
    const summary = await reconciler.runOnce({ execute: true, limit: options.limit });
    console.log('[done]', JSON.stringify(summary));
    if (summary.failed > 0) process.exitCode = 2;
  } finally {
    await sessionLock?.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[error]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
