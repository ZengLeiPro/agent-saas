import type pg from 'pg';

import type { AppConfig } from '../app/config.js';
import type { CodexCredentialManager } from '../runtime/responses/codexCredentialManager.js';
import type { SecretVault } from '../security/secretVault.js';
import { ProviderQuotaService } from './providerQuotaService.js';
import { PgProviderQuotaSnapshotStore } from './providerQuotaSnapshotStore.js';

export interface ProviderQuotaRuntime {
  service: ProviderQuotaService;
  stop: () => void;
}

/** PG runtime 装配：建表 → 服务 → （singleton Worker）启动周期采集。 */
export async function createProviderQuotaRuntime(options: {
  pool: pg.Pool;
  tablePrefix?: string;
  getModelsConfig: () => AppConfig['models'];
  secretVault?: SecretVault;
  codexCredentialManager: CodexCredentialManager;
  enableCollector: boolean;
  fetchImpl: typeof fetch;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}): Promise<ProviderQuotaRuntime> {
  const store = new PgProviderQuotaSnapshotStore(options.pool, {
    tablePrefix: options.tablePrefix,
  });
  await store.init();
  const service = new ProviderQuotaService({
    store,
    getModelsConfig: options.getModelsConfig,
    secretVault: options.secretVault,
    codexCredentialManager: options.codexCredentialManager,
    enableCollector: options.enableCollector,
    fetchImpl: options.fetchImpl,
    logger: options.logger,
  });
  service.start();
  return { service, stop: () => service.stop() };
}
