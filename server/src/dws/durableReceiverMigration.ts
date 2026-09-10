import { createHash } from 'node:crypto';

import type {
  AgentDwsAccountRecord,
  AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import {
  type DwsReceiverMigrationRecord,
  PgDwsDeliveryStore,
} from '../data/agentDwsAccounts/durableDeliveryStore.js';
import { HttpTransport } from '../runtime/httpTransport.js';
import type { DwsReceiverSource, DwsReceiverWorkspace } from '../runtime/dwsReceiverProtocol.js';
import {
  deriveDwsPrincipalWorkspaceId,
  deriveDwsWorkspaceMountSubPath,
  resolveDwsPrincipalCwd,
} from './authFlow.js';
import { principalFor } from './agentAuthFlow.js';
import { DwsReceiverClient, type DwsReceiverCapabilities } from './dwsReceiverClient.js';
import type { DwsEventGateway } from './personalEventGateway.js';

const LEGACY_STOP_PROOF_MS = 20_000;
const LEGACY_STOP_POLL_MS = 500;

export interface DwsLegacyStopProof {
  invocationId: string;
  provenance: 'journal';
  operations: Array<{
    operationId: string;
    attemptId: string;
    resource: 'stopped' | 'not_started';
    updatedAt: string;
  }>;
}

export interface DwsReceiverMigrationView extends DwsReceiverMigrationRecord {
  diagnostics?: Record<string, unknown> | null;
}

export interface DwsReceiverMigrationService {
  activate(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
    actor: string,
  ): Promise<DwsReceiverMigrationRecord>;
  reconcile(tenantId: string, accountId: string): Promise<DwsReceiverMigrationRecord>;
  status(tenantId: string, accountId: string): Promise<DwsReceiverMigrationView | null>;
  abort(tenantId: string, accountId: string, actor: string): Promise<DwsReceiverMigrationRecord>;
  assertRollbackAllowed(tenantId: string, accountId: string): Promise<void>;
}

interface LegacyBridge {
  capabilities(account: AgentDwsAccountRecord): Promise<DwsReceiverCapabilities>;
  stopAndProve(account: AgentDwsAccountRecord): Promise<DwsLegacyStopProof>;
}

export class DurableDwsReceiverMigrationService implements DwsReceiverMigrationService {
  constructor(
    private readonly options: {
      accountStore: AgentDwsAccountStore;
      deliveryStore: PgDwsDeliveryStore;
      legacyGateway: DwsEventGateway;
      durableGateway: DwsEventGateway;
      bridge: LegacyBridge;
      agentCwd: string;
    },
  ) {}

  async activate(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
    actor: string,
  ): Promise<DwsReceiverMigrationRecord> {
    const account = await this.requireAccount(tenantId, accountId);
    if (account.revision !== expectedRevision) throw new Error('migration_revision_conflict');
    const capabilities = await this.options.bridge.capabilities(account);
    const registration = migrationRegistration(account, actor, capabilities, this.options.agentCwd);
    const migration = await this.options.deliveryStore.prepareMigration(registration);
    return await this.handoff(account, migration);
  }

  async reconcile(tenantId: string, accountId: string): Promise<DwsReceiverMigrationRecord> {
    const migration = await this.options.deliveryStore.migration(tenantId, accountId);
    if (!migration || !['planned', 'handoff_pending', 'blocked'].includes(migration.state)) {
      throw new Error('migration_not_reconcilable');
    }
    const account = await this.requireAccount(tenantId, accountId);
    await this.options.bridge.capabilities(account);
    return await this.handoff(account, migration);
  }

  async status(tenantId: string, accountId: string): Promise<DwsReceiverMigrationView | null> {
    const migration = await this.options.deliveryStore.migration(tenantId, accountId);
    if (!migration) return null;
    return {
      ...migration,
      diagnostics: await this.options.deliveryStore.diagnostics(tenantId, accountId),
    };
  }

  async abort(
    tenantId: string,
    accountId: string,
    actor: string,
  ): Promise<DwsReceiverMigrationRecord> {
    const migration = await this.options.deliveryStore.migration(tenantId, accountId);
    if (!migration || migration.state !== 'planned') throw new Error('migration_abort_unsafe');
    return await this.options.deliveryStore.abortPlannedMigration(migration.migrationId, actor);
  }

  async assertRollbackAllowed(tenantId: string, accountId: string): Promise<void> {
    const migration = await this.options.deliveryStore.migration(tenantId, accountId);
    if (migration && migration.state !== 'aborted')
      throw new Error('reader_capable_rollback_floor_required');
  }

  private async handoff(
    accountSnapshot: AgentDwsAccountRecord,
    initial: DwsReceiverMigrationRecord,
  ): Promise<DwsReceiverMigrationRecord> {
    let migration = initial;
    try {
      if (migration.state === 'planned')
        migration = await this.options.deliveryStore.beginMigration(migration.migrationId);
      const account = await this.requireAccount(migration.tenantId, migration.accountId);
      const stop = this.options.legacyGateway.stopAccount(account.accountId, account);
      void stop.catch(() => undefined);
      const proof = await this.options.bridge.stopAndProve(account);
      await observeLocalStop(stop);
      const activated = await this.options.deliveryStore.activateMigration(migration.migrationId, {
        legacyStopProof: proof,
        activatedAt: new Date().toISOString(),
        minimumRollbackProtocol: 1,
      });
      const current = await this.requireAccount(activated.tenantId, activated.accountId);
      // Activation is already durable. Worker reconciliation owns retries if the
      // immediate wake cannot reach the receiver after this transaction commits.
      void this.options.durableGateway.startAccount(current).catch(() => undefined);
      return activated;
    } catch (error) {
      if (migration.state !== 'planned')
        await this.options.deliveryStore
          .blockMigration(migration.migrationId, {
            blocker: code(error),
            blockedAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      throw error;
    }
  }

  private async requireAccount(
    tenantId: string,
    accountId: string,
  ): Promise<AgentDwsAccountRecord> {
    const account = await this.options.accountStore.getForTenant(tenantId, accountId);
    if (!account) throw new Error('migration_account_not_found');
    return account;
  }
}

export class AcsDwsLegacyBridge implements LegacyBridge {
  constructor(
    private readonly options: {
      resolveRemote(
        account: AgentDwsAccountRecord,
      ): Promise<{ baseUrl: string; authToken: string; invokeTimeoutMs?: number }>;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async capabilities(account: AgentDwsAccountRecord): Promise<DwsReceiverCapabilities> {
    const remote = await this.options.resolveRemote(account);
    return await new DwsReceiverClient({
      ...remote,
      fetchImpl: this.options.fetchImpl,
    }).capabilities();
  }

  async stopAndProve(account: AgentDwsAccountRecord): Promise<DwsLegacyStopProof> {
    const invocationId = `agent-dws-events-${account.accountId}`;
    const remote = await this.options.resolveRemote(account);
    const transport = new HttpTransport({
      ...remote,
      fetchImpl: this.options.fetchImpl,
      connectRetryBackoffMs: [],
      invocationResultRequestTimeoutMs: 2_000,
    });
    await transport.cancelInvocation(invocationId);
    const deadline = Date.now() + LEGACY_STOP_PROOF_MS;
    while (Date.now() < deadline) {
      const proof = await this.readProof(remote, invocationId).catch(() => null);
      if (proof) return proof;
      await delay(LEGACY_STOP_POLL_MS);
    }
    throw new Error('legacy_stop_proof_unavailable');
  }

  private async readProof(
    remote: { baseUrl: string; authToken: string },
    invocationId: string,
  ): Promise<DwsLegacyStopProof | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    timer.unref?.();
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${remote.baseUrl.replace(/\/$/, '')}/operations?invocationId=${encodeURIComponent(invocationId)}`,
        {
          headers: { authorization: `Bearer ${remote.authToken}` },
          signal: controller.signal,
          redirect: 'error',
        },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as Record<string, unknown>;
      if (
        body.provenance !== 'journal' ||
        body.journalAvailable !== true ||
        body.invocationId !== invocationId ||
        !Array.isArray(body.operations) ||
        body.operations.length === 0
      )
        return null;
      const operations = body.operations.map((value) => terminalOperation(value, invocationId));
      return operations.every(Boolean)
        ? {
            invocationId,
            provenance: 'journal',
            operations: operations as DwsLegacyStopProof['operations'],
          }
        : null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function migrationRegistration(
  account: AgentDwsAccountRecord,
  actor: string,
  capabilities: DwsReceiverCapabilities,
  agentCwd: string,
): Parameters<PgDwsDeliveryStore['prepareMigration']>[0] {
  if (!account.profileId || !account.identityUpdatedAt || account.eventKinds.length === 0) {
    throw new Error('migration_legacy_identity_required');
  }
  const principal = principalFor(account);
  const workspaceId = deriveDwsPrincipalWorkspaceId(principal);
  const root = resolveDwsPrincipalCwd(agentCwd, principal);
  const mountSubPath = deriveDwsWorkspaceMountSubPath(agentCwd, root);
  if (!mountSubPath) throw new Error('migration_workspace_unavailable');
  const receiverId = `drx-${createHash('sha256').update(account.accountId).digest('hex').slice(0, 24)}`;
  const source: DwsReceiverSource = {
    accountId: account.accountId,
    receiverId,
    profileId: account.profileId,
    identityUpdatedAt: account.identityUpdatedAt,
    eventKinds: [...account.eventKinds].sort(),
  };
  const workspace: DwsReceiverWorkspace = {
    id: workspaceId,
    sessionId: `agent-dws-events-${account.accountId}`,
    sandboxScopeId: `${workspaceId}__dws_events`,
    mountSubPath,
  };
  return {
    account,
    receiverId,
    source,
    workspace,
    actor,
    evidence: {
      plannedAt: new Date().toISOString(),
      legacyInvocationId: `agent-dws-events-${account.accountId}`,
      receiverSourceSha: capabilities.sourceSha,
      minimumRollbackProtocol: capabilities.minimumRollbackProtocol,
      upstreamReplay: capabilities.upstreamReplay,
    },
  };
}

function terminalOperation(
  value: unknown,
  invocationId: string,
): DwsLegacyStopProof['operations'][number] | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (
    item.invocationId !== invocationId ||
    (item.resource !== 'stopped' && item.resource !== 'not_started') ||
    typeof item.operationId !== 'string' ||
    typeof item.attemptId !== 'string' ||
    typeof item.updatedAt !== 'string'
  )
    return null;
  return {
    operationId: item.operationId,
    attemptId: item.attemptId,
    resource: item.resource,
    updatedAt: item.updatedAt,
  };
}

async function observeLocalStop(work: Promise<void>): Promise<void> {
  await Promise.race([work, delay(2_000)]);
}

function code(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,128}$/.test(value) ? value : 'migration_failed';
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
