#!/usr/bin/env tsx
/**
 * Backfill runtime_sessions from transcript .meta.json files.
 *
 * Default is dry-run. Use --execute to write PG.
 *
 * Usage:
 *   pnpm -C server run backfill:runtime-sessions
 *   pnpm -C server run backfill:runtime-sessions -- --execute
 *   pnpm -C server run backfill:runtime-sessions -- --connection-string postgresql://... --table-prefix runtime
 */
import { resolve } from 'node:path';

import { loadAppConfig } from '../src/app/config.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../src/data/transcripts/projectKey.js';
import {
  PgSessionProjectionStore,
  runtimeSessionsDdl,
  scanRuntimeSessionMetaFiles,
} from '../src/runtime/sessionProjectionStore.js';

interface Options {
  execute: boolean;
  root: string;
  connectionString?: string;
  tablePrefix: string;
}

function pickArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0) return process.argv[idx + 1];
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function parseOptions(): Options {
  const config = loadAppConfig(process.cwd());
  const runtimePg = config.runtimeEventStore?.backend === 'pg'
    ? config.runtimeEventStore
    : undefined;
  return {
    execute: process.argv.includes('--execute'),
    root: resolve(pickArg('--root') ?? process.env.AGENT_TRANSCRIPTS_ROOT ?? AGENT_LEGACY_TRANSCRIPTS_ROOT),
    connectionString: pickArg('--connection-string') ?? runtimePg?.connectionString,
    tablePrefix: pickArg('--table-prefix') ?? runtimePg?.tablePrefix ?? 'runtime',
  };
}

function printSql(tablePrefix: string): void {
  console.log('[sql] DDL:');
  for (const sql of runtimeSessionsDdl(tablePrefix)) console.log(`  ${sql}`);
  const table = `${tablePrefix}_sessions`;
  console.log('[sql] backfill writes:');
  console.log(`  INSERT INTO ${table} (...) VALUES (...) ON CONFLICT (session_id) DO UPDATE SET ...;`);
  console.log(`  DELETE FROM ${table} WHERE NOT (session_id = ANY($1::text[]));`);
}

async function main(): Promise<void> {
  const opts = parseOptions();
  console.log(`[start] mode=${opts.execute ? 'EXECUTE' : 'DRY-RUN'} root=${opts.root} tablePrefix=${opts.tablePrefix}`);
  printSql(opts.tablePrefix);

  const scan = await scanRuntimeSessionMetaFiles(opts.root);
  console.log('[scan]', JSON.stringify({
    scannedMetaFiles: scan.scannedMetaFiles,
    validMetaFiles: scan.files.length,
    skippedInvalidBasename: scan.skippedInvalidBasename,
  }));

  if (!opts.connectionString) {
    if (opts.execute) {
      throw new Error('--connection-string is required for --execute when config.runtimeEventStore.backend!="pg"');
    }
    console.log('[dry-run] PG connection string missing; skipped existing-row comparison.');
    return;
  }

  const store = new PgSessionProjectionStore({
    connectionString: opts.connectionString,
    tablePrefix: opts.tablePrefix,
  });
  try {
    if (!opts.execute) {
      const plan = await store.planBackfill(opts.root);
      console.log('[plan]', JSON.stringify({
        scannedMetaFiles: plan.scannedMetaFiles,
        validMetaFiles: plan.validMetaFiles,
        skippedInvalidBasename: plan.skippedInvalidBasename,
        existingRows: plan.existingRows,
        wouldUpsert: plan.wouldUpsert,
        wouldDeleteMissing: plan.wouldDeleteMissing,
      }));
      console.log('[done] dry-run only — pass --execute to write PG.');
      return;
    }

    await store.init();
    const result = await store.reconcileFromFileSystem(opts.root);
    console.log('[done] execute summary:', JSON.stringify({
      scannedMetaFiles: result.scannedMetaFiles,
      validMetaFiles: result.validMetaFiles,
      skippedInvalidBasename: result.skippedInvalidBasename,
      upserted: result.upserted,
      deletedMissing: result.deletedMissing,
    }));
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error('[error]', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
