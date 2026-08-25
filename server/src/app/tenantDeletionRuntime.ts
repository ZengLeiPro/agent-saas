import type { WebChannel } from '../channels/web/channel.js';
import { GovernanceTenantCleanup } from '../data/changeJobs/index.js';
import {
  createDurableTenantDeletionExecutor,
  verifyTenantDeletionResiduals,
  type TenantDeletionReport,
  type TenantDeletionVerificationOptions,
  type TenantExternalRuntimeResiduals,
} from '../data/tenants/cleanup.js';
import { requestAcsOrchestrator } from '../routes/runtimeOperationsAdmin.js';
import type { SecretVault } from '../security/secretVault.js';
import { serverLogger } from '../utils/logger.js';
import type { AppConfig } from './config.js';
import type { AppRuntime } from './runtime.js';

const SANDBOX_NAME = /^as-[a-z0-9-]{1,60}$/;

type AcsSandbox = { name: string; workspaceId: string };

export function createTenantExternalRuntimeLifecycle(
  config: AppConfig,
  secretVault?: SecretVault,
  fetchImpl: typeof fetch = fetch,
) {
  const inspect = async (tenantId: string): Promise<TenantExternalRuntimeResiduals & { sandboxesFound: AcsSandbox[] }> => {
    const response = await requestAcsOrchestrator({
      config, secretVault, fetchImpl, timeoutMs: 10_000, path: '/sandboxes', method: 'GET',
    });
    if (response.status === 404 && (response.body as { error?: unknown })?.error === 'ACS hand not configured') {
      return { sandboxes: 0, trafficPolicies: 0, snat: 0, authority: 'app-config:acs-runtime-not-configured', sandboxesFound: [] };
    }
    if (response.status !== 200 || !Array.isArray((response.body as { sandboxes?: unknown })?.sandboxes)) {
      throw new Error(`TENANT_DELETE_ACS_VERIFY_FAILED:${response.status}`);
    }
    const prefix = `ws_${tenantId}__`;
    const sandboxesFound = (response.body as { sandboxes: unknown[] }).sandboxes.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const row = item as { name?: unknown; workspaceId?: unknown };
      return typeof row.name === 'string' && typeof row.workspaceId === 'string' && row.workspaceId.startsWith(prefix)
        ? [{ name: row.name, workspaceId: row.workspaceId }] : [];
    });
    const count = sandboxesFound.length;
    return {
      sandboxes: count, trafficPolicies: count, snat: count,
      authority: 'acs-orchestrator:/sandboxes (Sandbox owns TrafficPolicy and SNAT lifecycle)', sandboxesFound,
    };
  };
  return {
    verify: async (tenantId: string) => {
      const { sandboxesFound: _sandboxesFound, ...result } = await inspect(tenantId);
      return result;
    },
    cleanup: async (tenantId: string) => {
      const before = await inspect(tenantId);
      for (const sandbox of before.sandboxesFound) {
        if (!SANDBOX_NAME.test(sandbox.name)) throw new Error('TENANT_DELETE_ACS_SANDBOX_NAME_INVALID');
        const deleted = await requestAcsOrchestrator({
          config, secretVault, fetchImpl, timeoutMs: 10_000,
          path: `/sandboxes/${encodeURIComponent(sandbox.name)}`, method: 'DELETE',
        });
        if (![200, 404].includes(deleted.status)) throw new Error(`TENANT_DELETE_ACS_CLEANUP_FAILED:${deleted.status}`);
      }
      const { sandboxesFound: _sandboxesFound, ...result } = await inspect(tenantId);
      return result;
    },
  };
}

export function createRouteTenantDeletionExecutor(
  runtime: AppRuntime,
  deleteResources: ((tenantId: string) => Promise<TenantDeletionReport>) | undefined,
  webChannel: WebChannel | undefined,
  verification: Pick<TenantDeletionVerificationOptions,
    'agentCwd' | 'sharedDir' | 'tenantSkillsRootDir' | 'verifyExternalRuntime'> | undefined,
) {
  const { governanceChangeJobStore: jobs, runtimePgEventStore, secretVault, tenantStore, userStore } = runtime;
  if (!deleteResources || !jobs || !runtimePgEventStore || !secretVault || !tenantStore || !userStore || !verification) return undefined;
  const governanceCleanup = new GovernanceTenantCleanup({
    pool: runtimePgEventStore.pool,
    tablePrefix: runtimePgEventStore.eventsTable.replace(/_events$/, ''),
    vault: secretVault,
  });
  const executor = createDurableTenantDeletionExecutor({
    jobs,
    tenantStore,
    deleteResources,
    governanceCleanup,
    verifyResources: tenantId => verifyTenantDeletionResiduals({
      ...verification, userStore, runtimePgEventStore,
      runtimeRunStore: runtime.runtimeRunStore,
      runtimeSessionProjectionStore: runtime.runtimeSessionProjectionStore,
      runtimeToolInvocationStore: runtime.runtimeToolInvocationStore,
    }, tenantId),
    onFrozen: (tenantId) => webChannel?.disconnectTenant(tenantId),
    workerId: 'tenant-deletion-runtime',
    onJobError: (error, job) => serverLogger.error(
      `Tenant deletion consumer failed tenant=${job.tenantId} job=${job.jobId} status=${job.status}:`,
      error,
    ),
  });
  executor.start();
  runtime.tenantDeletionShutdown = () => executor.stop();
  return executor;
}
