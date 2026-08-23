import { DerivedContextAdminReadStore } from '../context/derived/index.js';
import type { ContextAdminConsumerStorePort } from '../routes/contextAdmin.js';
import type { AppConfig } from '../types/index.js';
import type { AppRuntime } from './runtimeContracts.js';

export function createContextAdminConsumerStore(
  runtime: AppRuntime,
  config: AppConfig,
): ContextAdminConsumerStorePort | undefined {
  const pool = runtime.runtimePgEventStore?.pool;
  if (!pool) return undefined;
  return new DerivedContextAdminReadStore(
    pool,
    config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore.tablePrefix : undefined,
  );
}
