import { createHash } from 'node:crypto';

import { DerivedContextAdminReadStore } from '../context/derived/index.js';
import {
  ContextRetentionAuditConsumer,
  ContextRetentionStore,
  ContextRetentionWorker,
  type ContextRetentionReceipt,
} from '../context/lifecycle/index.js';
import {
  ContextProductAuthorization,
  ContextProductService,
  PgContextProductStore,
} from '../context/product/index.js';
import { AssignmentContextRecallScopeResolver } from '../context/retrieval/index.js';
import type { ContextAdminConsumerStorePort } from '../routes/contextAdmin.js';
import type { AppConfig } from '../types/index.js';
import type { AppRuntime } from './runtimeContracts.js';

export function createContextRetentionWorker(
  runtime: AppRuntime,
  config: AppConfig,
): ContextRetentionWorker | undefined {
  const pool = runtime.runtimePgEventStore?.pool;
  const audit = runtime.governanceAuditStore;
  if (!pool || !audit) return undefined;
  const tablePrefix = config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore.tablePrefix : undefined;
  return new ContextRetentionWorker(
    new ContextRetentionStore({ pool, ...(tablePrefix ? { tablePrefix } : {}) }),
    contextRetentionAuditSink(audit),
  );
}

/** Starts only in the runtime worker role; it replays committed receipts and never runs GC plans. */
export function createRuntimeContextPlaneShutdown(
  contextPlane: { stop(): Promise<void> } | undefined,
  runtime: Pick<AppRuntime, 'runtimePgEventStore' | 'governanceAuditStore'>,
  config: AppConfig,
  enabled: boolean,
  logger: { info(message: string): void; warn(message: string): void },
): (() => Promise<void>) | undefined {
  const consumer = createContextRetentionAuditConsumer(runtime, config, enabled, logger);
  if (!contextPlane && !consumer) return undefined;
  return async () => {
    await consumer?.stop();
    await contextPlane?.stop();
  };
}

function createContextRetentionAuditConsumer(
  runtime: Pick<AppRuntime, 'runtimePgEventStore' | 'governanceAuditStore'>,
  config: AppConfig,
  enabled: boolean,
  logger: { info(message: string): void; warn(message: string): void },
): ContextRetentionAuditConsumer | undefined {
  if (!enabled) return undefined;
  const pool = runtime.runtimePgEventStore?.pool;
  const audit = runtime.governanceAuditStore;
  if (!pool || !audit) return undefined;
  const tablePrefix = config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore.tablePrefix : undefined;
  const consumer = new ContextRetentionAuditConsumer(
    new ContextRetentionStore({ pool, ...(tablePrefix ? { tablePrefix } : {}) }),
    contextRetentionAuditSink(audit),
    { logger },
  );
  consumer.start();
  return consumer;
}

function contextRetentionAuditSink(audit: NonNullable<AppRuntime['governanceAuditStore']>) {
  return async (receipt: ContextRetentionReceipt): Promise<void> => {
    try {
      await audit.append({
        auditId: receipt.receiptId,
        correlationId: receipt.receiptId,
        actorType: 'service', actorUserId: 'context-retention-worker', actorPersona: 'service',
        action: 'context.retention.collect', targetType: 'context_retention_receipt',
        targetId: receipt.receiptId, targetTenantId: receipt.tenantId,
        purpose: 'context retention and garbage collection', result: 'succeeded',
        afterDigest: receipt.receiptSha256,
        metadata: {
          dryRun: receipt.dryRun,
          sourceOutboxWatermark: receipt.sourceOutboxWatermark,
          derivedOutboxWatermark: receipt.derivedOutboxWatermark,
          sourceOutboxCount: receipt.counts.sourceOutbox,
          derivedOutboxCount: receipt.counts.derivedOutbox,
          evidenceCount: receipt.counts.evidence,
          revisionCount: receipt.counts.revisions,
        },
      });
    } catch (error) {
      // A deterministic audit id makes retry idempotent after an uncertain append outcome.
      if ((error as { code?: string })?.code !== '23505') throw error;
    }
  };
}

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

export function createContextProductService(
  runtime: AppRuntime,
  config: AppConfig,
): ContextProductService | undefined {
  const pool = runtime.runtimePgEventStore?.pool;
  const assignments = runtime.assignmentStore;
  const registry = runtime.contextSourceAuthorizationRegistry;
  const derived = runtime.derivedContextStore;
  const memberships = runtime.membershipStore;
  const entitlements = runtime.entitlementStore;
  const secret = config.auth?.jwtSecret;
  if (!pool || !assignments || !registry || !derived || !memberships || !entitlements || !secret) return undefined;
  const tablePrefix = config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore.tablePrefix : undefined;
  const roleGate = {
    mayCorrectOrganization: async ({ tenantId, actorId }: { tenantId: string; actorId: string }) => {
      const membership = await memberships.getMembership(tenantId, actorId);
      return membership?.status === 'active' && membership.persona === 'org_admin';
    },
  };
  return new ContextProductService({
    store: new PgContextProductStore(pool, tablePrefix),
    scopes: new AssignmentContextRecallScopeResolver(assignments, {
      resourceTypes: ['org_knowledge'],
      resolveAccess: async subject => {
        const [membership, policies] = await Promise.all([
          memberships.getMembership(subject.tenantId, subject.userId),
          entitlements.getPolicies(subject.tenantId),
        ]);
        return {
          activeMembership: membership?.status === 'active',
          organizationKnowledgeEnabled: policies.some(policy => (
            policy.policyKey === 'knowledge.org.enabled' && policy.value === true
          )),
        };
      },
    }),
    authorization: new ContextProductAuthorization(
      registry,
      createHash('sha256').update(`context-product:${secret}`).digest(),
    ),
    derived,
    roleGate,
  });
}
