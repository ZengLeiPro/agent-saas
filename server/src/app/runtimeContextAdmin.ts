import { createHash } from 'node:crypto';

import { DerivedContextAdminReadStore } from '../context/derived/index.js';
import {
  ContextProductAuthorization,
  ContextProductService,
  PgContextProductStore,
} from '../context/product/index.js';
import { AssignmentContextRecallScopeResolver } from '../context/retrieval/index.js';
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

export function createContextProductService(
  runtime: AppRuntime,
  config: AppConfig,
): ContextProductService | undefined {
  const pool = runtime.runtimePgEventStore?.pool;
  const assignments = runtime.assignmentStore;
  const registry = runtime.contextSourceAuthorizationRegistry;
  const derived = runtime.derivedContextStore;
  const memberships = runtime.membershipStore;
  const secret = config.auth?.jwtSecret;
  if (!pool || !assignments || !registry || !derived || !memberships || !secret) return undefined;
  const tablePrefix = config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore.tablePrefix : undefined;
  const roleGate = {
    mayCorrectOrganization: async ({ tenantId, actorId }: { tenantId: string; actorId: string }) => {
      const membership = await memberships.getMembership(tenantId, actorId);
      return membership?.status === 'active' && membership.persona === 'org_admin';
    },
  };
  return new ContextProductService({
    store: new PgContextProductStore(pool, tablePrefix),
    scopes: new AssignmentContextRecallScopeResolver(assignments, { resourceTypes: ['org_knowledge'] }),
    authorization: new ContextProductAuthorization(
      registry,
      createHash('sha256').update(`context-product:${secret}`).digest(),
    ),
    derived,
    roleGate,
  });
}
