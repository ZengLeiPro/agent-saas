import { dirname, join, resolve } from 'node:path';
import { createAuthMiddleware } from '../auth/middleware.js';
import { AuthEpochAuthority } from '../auth/authEpochAuthority.js';
import { withPgAdvisoryLock } from '../cron/bootstrap.js';
import { TenantStore } from '../data/tenants/store.js';
import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID } from '../data/tenants/types.js';
import { UserStore } from '../data/users/store.js';
import type { AppConfig } from '../types/index.js';

export async function initializeRuntimeAuth(input: {
  config: AppConfig;
  processCwd: string;
  logger: { info(message: string): void };
}): Promise<{
  userStore?: UserStore;
  tenantStore?: TenantStore;
  authEpochAuthority?: AuthEpochAuthority;
  tenantsFilePath?: string;
  authMiddleware?: ReturnType<typeof createAuthMiddleware>;
}> {
  const { config, processCwd, logger } = input;
  if (!config.auth?.enabled || !config.auth.jwtSecret) return {};

  const usersFilePath = resolve(processCwd, config.auth.usersFile || './data/users.json');
  const userStore = new UserStore(usersFilePath);
  const authEpochAuthority = new AuthEpochAuthority(
    join(dirname(usersFilePath), 'auth-epochs.json'),
    (event) => logger.info(JSON.stringify({ category: 'auth_lifecycle', ...event })),
  );
  const tenantsFilePath = join(dirname(usersFilePath), 'tenants.json');
  const tenantPgConfig = config.runtimeEventStore?.backend === 'pg'
    ? config.runtimeEventStore
    : undefined;
  const tenantStore = new TenantStore(tenantsFilePath, tenantPgConfig ? {
    withLock: <T>(operation: () => Promise<T>) => withPgAdvisoryLock(
      tenantPgConfig.connectionString,
      `${tenantPgConfig.tablePrefix ?? 'agent_saas'}:tenant-store`,
      operation,
    ),
  } : { useLocalLock: false });
  await tenantStore.ensureDefaultTenant();
  await tenantStore.ensureKaiyanTenant();
  const authMiddleware = createAuthMiddleware(
    config.auth.jwtSecret,
    userStore,
    tenantStore,
    config.auth.tokenExpiresIn || '30d',
    undefined,
    authEpochAuthority,
  );
  logger.info('Auth enabled');
  logger.info(`Tenant store loaded: ${tenantStore.count()} tenant(s), platform='${DEFAULT_TENANT_ID}', legacy='${LEGACY_TENANT_ID}'`);
  return { userStore, tenantStore, authEpochAuthority, tenantsFilePath, authMiddleware };
}
