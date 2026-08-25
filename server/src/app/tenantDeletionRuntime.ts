import type { WebChannel } from '../channels/web/channel.js';
import { GovernanceTenantCleanup } from '../data/changeJobs/index.js';
import {
  createDurableTenantDeletionExecutor,
  type TenantDeletionReport,
} from '../data/tenants/cleanup.js';
import type { AppRuntime } from './runtime.js';

export function createRouteTenantDeletionExecutor(
  runtime: AppRuntime,
  deleteResources: ((tenantId: string) => Promise<TenantDeletionReport>) | undefined,
  webChannel: WebChannel | undefined,
) {
  const { governanceChangeJobStore: jobs, runtimePgEventStore, secretVault, tenantStore } = runtime;
  if (!deleteResources || !jobs || !runtimePgEventStore || !secretVault || !tenantStore) return undefined;
  return createDurableTenantDeletionExecutor({
    jobs,
    tenantStore,
    deleteResources,
    governanceCleanup: new GovernanceTenantCleanup({
      pool: runtimePgEventStore.pool,
      tablePrefix: runtimePgEventStore.eventsTable.replace(/_events$/, ''),
      vault: secretVault,
    }),
    onFrozen: (tenantId) => webChannel?.disconnectTenant(tenantId),
    workerId: 'tenant-deletion-route',
  });
}
