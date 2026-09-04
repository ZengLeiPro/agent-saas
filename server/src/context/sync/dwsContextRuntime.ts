import { randomUUID } from 'node:crypto';

import {
  failClosedAgentDwsContextPolicy,
  hasExactAgentDwsProfile,
  type AgentDwsAccountRecord,
  type AgentDwsAccountStore,
  type AgentDwsContextPolicy,
  type AgentDwsContextPolicySelection,
} from '../../data/agentDwsAccounts/index.js';
import type { OrgGroupAgentStore } from '../../data/orgGroupAgents/index.js';
import { principalFor } from '../../dws/agentAuthFlow.js';
import {
  deriveDwsPrincipalWorkspaceId,
  resolveDwsPrincipalCwd,
  type DwsWorkspacePrincipal,
} from '../../dws/authFlow.js';
import type { DwsPersonalEvent } from '../../dws/personalEventGateway.js';
import { DWS_CONNECTOR_SANDBOX_RESOURCES } from '../../dws/sandboxResources.js';
import {
  deriveAgentWorkspaceMountSubPath,
} from '../../dws/personalMessageSender.js';
import { HttpTransport } from '../../runtime/httpTransport.js';
import type { ContextStore } from '../store/index.js';
import { ContextStoreError } from '../store/index.js';
import {
  ContextStoreSyncAdapter,
  defaultPartitionIdentity,
} from './contextStoreAdapter.js';
import {
  DwsCliContextClient,
  type DwsCliExecutionContext,
  type DwsCliJsonExecutor,
} from './dwsCliClient.js';
import { DwsContextSyncService } from './service.js';
import type { ContextSyncKey, ContextSyncScope, ContextSyncSource, ContextSyncTarget } from './types.js';

const DWS_CONTEXT_COMMAND_TIMEOUT_MS = 120_000;
const DWS_CONTEXT_INITIAL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;
const DWS_CONTEXT_TICK_MS = 60_000;
const SOURCE_INTERVAL_MS: Readonly<Record<ContextSyncSource, number>> = {
  chat: 2 * 60_000,
  minutes: 30 * 60_000,
  wiki: 60 * 60_000,
};
const SOURCES: readonly ContextSyncSource[] = ['chat', 'minutes', 'wiki'];

interface RuntimeSyncTarget extends ContextSyncTarget {
  initialFrom?: string;
  lookbackDays?: number;
}

export type DwsContextServerRemoteResolver = (principal: DwsWorkspacePrincipal) => Promise<{
  baseUrl: string;
  authToken: string;
  invokeTimeoutMs?: number;
}>;

interface DwsContextLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface ContextCollectionAssignmentStore {
  getAssignmentSet(
    tenantId: string,
    resourceType: 'org_knowledge',
    resourceId: string,
  ): Promise<{ version: number } | null>;
  replaceAssignments(
    tenantId: string,
    resourceType: 'org_knowledge',
    resourceId: string,
    inputs: [],
    expectedVersion: number,
    updatedBy: string,
    metadata: { resourceName: string; status: 'enabled' },
  ): Promise<unknown>;
}

export interface DwsContextRuntimeOptions {
  agentCwd: string;
  accountStore: AgentDwsAccountStore;
  contextStore: ContextStore;
  assignmentStore?: ContextCollectionAssignmentStore;
  orgGroupAgentStore?: Pick<OrgGroupAgentStore, 'getBinding' | 'findWorkConversationByMessage'>;
  resolveServerRemote: DwsContextServerRemoteResolver;
  logger?: DwsContextLogger;
  clock?: () => Date;
  initialLookbackMs?: number;
  tickMs?: number;
  transportFactory?: (remote: Awaited<ReturnType<DwsContextServerRemoteResolver>>) => Pick<HttpTransport, 'invoke'>;
}

/**
 * Persistent Context sync worker for Agent DWS accounts.
 *
 * Stream events only wake a canonical chat pull. Periodic completeness comes from
 * deterministic DWS reads; ContextStore partition leases make duplicate workers safe.
 */
export class DwsContextRuntime {
  private readonly clock: () => Date;
  private readonly initialLookbackMs: number;
  private readonly tickMs: number;
  private readonly dueAt = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = true;

  constructor(private readonly options: DwsContextRuntimeOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.initialLookbackMs = positiveInteger(options.initialLookbackMs, DWS_CONTEXT_INITIAL_LOOKBACK_MS);
    this.tickMs = positiveInteger(options.tickMs, DWS_CONTEXT_TICK_MS);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), this.tickMs);
    this.timer.unref?.();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active?.catch(() => undefined);
  }

  /** Best-effort wake; caller should not make durable inbox ingestion depend on it. */
  async wake(account: AgentDwsAccountRecord, event: DwsPersonalEvent): Promise<void> {
    if (!event.conversationId || !isMessageWake(event.type)) return;
    // The stream holds an account snapshot. Re-read it so a policy reduction is
    // enforced before the next event without waiting for a stream restart.
    const current = await this.options.accountStore.getForTenant(account.tenantId, account.accountId);
    const policy = current ? contextPolicyFor(current) : failClosedAgentDwsContextPolicy();
    if (!current || current.status !== 'active' || !hasExactAgentDwsProfile(current)
      || !selectionAllows(policy.realtime, event.conversationId)) return;
    const historicalIncludesConversation = policy.historical.mode === 'all'
      || (policy.historical.mode === 'selected'
        && policy.historical.conversationIds.includes(event.conversationId));
    // Reuse exactly the same periodic partition. A historical-selected event
    // must not wake the broader realtime=all partition and accidentally backfill
    // unrelated conversations.
    const historicalSelected = policy.historical.mode === 'selected'
      ? [...new Set(policy.historical.conversationIds)].sort()
      : [];
    const historicalSet = new Set(historicalSelected);
    const realtimeOnly = policy.realtime.mode === 'selected'
      ? [...new Set(policy.realtime.conversationIds)]
          .filter(conversationId => !historicalSet.has(conversationId))
          .sort()
      : [];
    const target: RuntimeSyncTarget = historicalIncludesConversation
      ? {
          source: 'chat',
          ...(policy.historical.mode === 'selected' ? { conversationIds: historicalSelected } : {}),
          lookbackDays: policy.historical.lookbackDays,
        }
      : {
          source: 'chat',
          ...(policy.realtime.mode === 'selected' ? { conversationIds: realtimeOnly } : {}),
          initialFrom: earliestRealtimeConsent(policy, [event.conversationId])
            ?? eventInitialFrom(event.timestamp, this.clock()),
        };
    try {
      await this.syncTarget(current, target);
    } catch (error) {
      this.dueAt.set(this.dueKey(current, target), this.clock().getTime() + this.tickMs);
      throw error;
    }
  }

  /** Mirrors policy immediately; suitable for the account route callback. */
  async onContextPolicyUpdated(account: AgentDwsAccountRecord): Promise<void> {
    if (!account.profileId) return;
    if (!hasExactAgentDwsProfile(account)) {
      await this.pauseContextResources(account);
      return;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        for (const source of SOURCES) {
          await ensureContextResources(
            this.options.contextStore,
            this.options.assignmentStore,
            account,
            source,
          );
          const identity = defaultPartitionIdentity({ ...scopeFor(account), source });
          await this.options.contextStore.resetPartitionsForPolicyChange(
            account.tenantId,
            identity.sourceId,
            identity.collectionId,
          );
        }
        this.kick();
        return;
      } catch (error) {
        const retryable = error instanceof ContextStoreError
          && error.code === 'CONTEXT_VERSION_CONFLICT'
          && attempt < 2;
        if (retryable) continue;
        try {
          await this.pauseContextResources(account);
        } catch (pauseError) {
          this.options.logger?.warn?.(
            `DWS context fail-closed pause failed account=${safeId(account.accountId)}: ${compactError(pauseError)}`,
          );
          throw new AggregateError(
            [error, pauseError],
            'DWS context policy mirror and fail-closed pause both failed',
          );
        }
        throw error;
      }
    }
  }

  /** Re-materializes one governed group after its binding revision changes. */
  async onGroupBindingUpdated(account: AgentDwsAccountRecord, conversationId: string): Promise<void> {
    if (account.status !== 'active' || !hasExactAgentDwsProfile(account)) return;
    const policy = contextPolicyFor(account);
    const historicalAllowed = selectionAllows(policy.historical, conversationId);
    const realtimeAllowed = selectionAllows(policy.realtime, conversationId);
    if (!historicalAllowed && !realtimeAllowed) return;
    await ensureContextResources(this.options.contextStore, this.options.assignmentStore, account, 'chat');
    const identity = defaultPartitionIdentity({ ...this.scope(account), source: 'chat' });
    // The same DWS chat collection serves every consented conversation. Resetting its
    // canonical periodic partitions keeps retry/restart recovery durable and causes
    // every stored message to be revised with the current binding ownership metadata.
    await this.options.contextStore.resetPartitionsForPolicyChange(
      account.tenantId, identity.sourceId, identity.collectionId,
    );
    let firstError: unknown;
    for (const target of periodicTargets(account, ['chat'])) {
      try {
        await this.syncTarget(account, target);
      } catch (error) {
        firstError ??= error;
        this.dueAt.set(this.dueKey(account, target), this.clock().getTime() + this.tickMs);
      }
    }
    if (firstError) throw firstError;
  }

  private async pauseContextResources(account: AgentDwsAccountRecord): Promise<void> {
    const scope = scopeFor(account);
    const sourceIdentity = defaultPartitionIdentity({ ...scope, source: 'chat' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const source = await this.options.contextStore.getSource(account.tenantId, sourceIdentity.sourceId);
      if (!source || source.status === 'disabled') break;
      try {
        await this.options.contextStore.updateSource({
          tenantId: account.tenantId,
          sourceId: source.sourceId,
          expectedRevision: source.revision,
          status: 'disabled',
        });
        break;
      } catch (error) {
        if (!(error instanceof ContextStoreError)
          || error.code !== 'CONTEXT_VERSION_CONFLICT'
          || attempt === 2) throw error;
      }
    }
    for (const contextSource of SOURCES) {
      const identity = defaultPartitionIdentity({ ...scope, source: contextSource });
      const collection = await this.options.contextStore.getCollection(
        account.tenantId,
        identity.sourceId,
        identity.collectionId,
      );
      if (collection && collection.status !== 'disabled') {
        await this.options.contextStore.updateCollection({
          tenantId: account.tenantId,
          sourceId: identity.sourceId,
          collectionId: identity.collectionId,
          expectedRevision: collection.revision,
          status: 'disabled',
        });
      }
      await this.options.contextStore.resetPartitionsForPolicyChange(
        account.tenantId,
        identity.sourceId,
        identity.collectionId,
      );
    }
  }

  /** Disable and fence resources derived from an identity before that identity is replaced. */
  async invalidateAccountIdentity(account: AgentDwsAccountRecord): Promise<void> {
    if (!account.profileId) return;
    await this.pauseContextResources(account);
  }

  async onAccountEnabledChanged(account: AgentDwsAccountRecord, enabled: boolean): Promise<void> {
    if (enabled) {
      await this.onContextPolicyUpdated(account);
      return;
    }
    await this.pauseContextResources(account);
  }

  /** Explicit recovery for the current identity; refused partitions are never auto-cleared. */
  async resumeAccount(account: AgentDwsAccountRecord): Promise<void> {
    if (account.status !== 'active' || !hasExactAgentDwsProfile(account)) return;
    for (const source of SOURCES) {
      await ensureContextResources(
        this.options.contextStore,
        this.options.assignmentStore,
        account,
        source,
      );
      const identity = defaultPartitionIdentity({ ...scopeFor(account), source });
      await this.options.contextStore.resetRefusedPartitions(
        account.tenantId,
        identity.sourceId,
        identity.collectionId,
      );
    }
    await this.syncAccount(account);
  }

  /** Public for tests/diagnostics and post-auth backfill. */
  async syncAccount(
    account: AgentDwsAccountRecord,
    sources: readonly ContextSyncSource[] = SOURCES,
  ): Promise<void> {
    if (account.status !== 'active' || !hasExactAgentDwsProfile(account)) return;
    for (const target of periodicTargets(account, sources)) {
      try {
        await this.syncTarget(account, target);
      } catch (error) {
        // Re-enter quickly; syncTarget will read the durable nextRetryAt and
        // either replay the exact failed window or sleep until it is due.
        this.dueAt.set(this.dueKey(account, target), this.clock().getTime() + this.tickMs);
        this.options.logger?.warn?.(
          `DWS context sync failed account=${safeId(account.accountId)} source=${target.source}: ${compactError(error)}`,
        );
      }
    }
  }

  private async syncTarget(
    account: AgentDwsAccountRecord,
    target: RuntimeSyncTarget,
  ): Promise<void> {
    const current = await this.options.accountStore.getForTenant(account.tenantId, account.accountId);
    if (!current || current.status !== 'active' || !hasExactAgentDwsProfile(current)) return;
    const refreshedTarget = periodicTargets(current, [target.source])
      .find(candidate => this.dueKey(current, candidate) === this.dueKey(account, target));
    if (!refreshedTarget) return;
    account = current;
    target = refreshedTarget;
    const service = await this.serviceFor(account, target.source);
    const key: ContextSyncKey = {
      ...this.scope(account),
      source: target.source,
      ...(target.conversationId ? { conversationId: target.conversationId } : {}),
      ...(target.conversationIds ? { conversationIds: target.conversationIds } : {}),
    };
    const retry = await service.getRetryState(key);
    if (retry) {
      const retryAt = Date.parse(retry.nextAttemptAt);
      if (Number.isFinite(retryAt) && retryAt > this.clock().getTime()) {
        this.dueAt.set(this.dueKey(account, target), retryAt);
        return;
      }
      await service.retry(key);
    } else {
      await service.syncWindow({
        scope: this.scope(account),
        source: target.source,
        ...(target.conversationId ? { conversationId: target.conversationId } : {}),
        ...(target.conversationIds ? { conversationIds: target.conversationIds } : {}),
        ...(target.initialFrom ? { initialFrom: target.initialFrom }
          : target.lookbackDays ? {
              initialFrom: new Date(
                this.clock().getTime() - target.lookbackDays * 24 * 60 * 60_000,
              ).toISOString(),
            }
          : {}),
        to: this.clock().toISOString(),
      });
    }
    this.dueAt.set(
      this.dueKey(account, target),
      this.clock().getTime() + SOURCE_INTERVAL_MS[target.source],
    );
  }

  private kick(): void {
    if (this.stopped || this.active) return;
    const task = this.runDue()
      .catch(error => {
        this.options.logger?.warn?.(`DWS context scheduler failed: ${compactError(error)}`);
      })
      .finally(() => {
        if (this.active === task) this.active = undefined;
      });
    this.active = task;
    void task;
  }

  private async runDue(): Promise<void> {
    const accounts = await this.options.accountStore.listRunnable();
    const now = this.clock().getTime();
    for (const account of accounts) {
      const targets = periodicTargets(account, SOURCES)
        .filter(target => (this.dueAt.get(this.dueKey(account, target)) ?? 0) <= now);
      for (const target of targets) {
        try {
          await this.syncTarget(account, target);
        } catch (error) {
          this.dueAt.set(this.dueKey(account, target), this.clock().getTime() + this.tickMs);
          this.options.logger?.warn?.(
            `DWS context sync failed account=${safeId(account.accountId)} source=${target.source}: ${compactError(error)}`,
          );
        }
      }
      if (this.stopped) return;
    }
  }

  private async serviceFor(
    account: AgentDwsAccountRecord,
    source: ContextSyncSource,
  ): Promise<DwsContextSyncService> {
    const scope = this.scope(account);
    await ensureContextResources(
      this.options.contextStore,
      this.options.assignmentStore,
      account,
      source,
    );
    const executor = new DwsRemoteJsonExecutor({
      agentCwd: this.options.agentCwd,
      accountStore: this.options.accountStore,
      resolveServerRemote: this.options.resolveServerRemote,
      ...(this.options.transportFactory ? { transportFactory: this.options.transportFactory } : {}),
    });
    const syncStore = new ContextStoreSyncAdapter({
      store: this.options.contextStore,
      ...(this.options.orgGroupAgentStore ? {
        resolveRecordMetadata: (key, item) => this.resolveOrgAgentRecordMetadata(key, item),
      } : {}),
    });
    return new DwsContextSyncService({
      store: syncStore,
      client: new DwsCliContextClient({
        executor,
        beforeExecute: () => syncStore.heartbeat(),
        ...(this.options.logger?.warn ? {
          logger: { warn: (message: string) => this.options.logger?.warn?.(message) },
        } : {}),
      }),
      clock: this.clock,
      defaultLookbackMs: source === 'chat'
        ? contextPolicyFor(account).historical.lookbackDays * 86_400_000
        : this.initialLookbackMs,
    });
  }

  private scope(account: AgentDwsAccountRecord): ContextSyncScope {
    return {
      tenantId: account.tenantId,
      accountId: account.accountId,
      profileId: account.profileId!,
    };
  }

  private async resolveOrgAgentRecordMetadata(
    key: ContextSyncKey,
    item: { source: ContextSyncSource; sourceId: string; conversationId?: string },
  ): Promise<Record<string, string | number> | undefined> {
    const store = this.options.orgGroupAgentStore;
    if (!store || item.source !== 'chat' || !item.conversationId) return undefined;
    const binding = await store.getBinding(key.tenantId, key.accountId, item.conversationId);
    if (!binding || binding.channelKind !== 'group' || binding.activationState !== 'active'
      || !binding.enabled || !binding.policy.enabled || binding.policy.liveDeny
      || !binding.effectiveConfig.knowledge.contextEnabled) return undefined;
    const sourceId = defaultPartitionIdentity(key).sourceId;
    if (!binding.effectiveConfig.knowledge.sourceIds.includes(sourceId)) return undefined;
    const metadata: Record<string, string | number> = {
      // Historical messages are safe to backfill at the governed group boundary,
      // but are never guessed into whichever WorkConversation happens to be active.
      agentId: binding.agentId,
      bindingId: binding.bindingId,
      conversationSpaceId: binding.conversationSpaceId,
      policyRevision: binding.revision,
      visibility: 'conversation',
      orgAgentContextScope: 'group',
    };
    const conversation = await store.findWorkConversationByMessage({
      tenantId: key.tenantId,
      bindingId: binding.bindingId,
      accountId: key.accountId,
      conversationId: item.conversationId,
      messageIds: [item.sourceId],
    });
    if (!conversation) return metadata;
    return {
      ...metadata,
      orgAgentContextScope: 'work_conversation',
      workConversationId: conversation.workConversationId,
    };
  }

  private dueKey(account: AgentDwsAccountRecord, target: ContextSyncTarget): string {
    const scopeKey = target.conversationId
      ? `one:${target.conversationId}`
      : target.conversationIds
        ? `selected:${[...target.conversationIds].sort().join('\0')}`
        : '*';
    return `${account.tenantId}\0${account.accountId}\0${target.source}\0${scopeKey}`;
  }
}

interface DwsRemoteJsonExecutorOptions {
  agentCwd: string;
  accountStore: AgentDwsAccountStore;
  resolveServerRemote: DwsContextServerRemoteResolver;
  transportFactory?: DwsContextRuntimeOptions['transportFactory'];
}

/** Executes scheduled DWS argv in the account's isolated cron connector workspace. */
export class DwsRemoteJsonExecutor implements DwsCliJsonExecutor {
  constructor(private readonly options: DwsRemoteJsonExecutorOptions) {}

  async json(
    args: readonly string[],
    execution: { env?: Readonly<Record<string, string>>; context: DwsCliExecutionContext },
  ): Promise<unknown> {
    const account = await this.options.accountStore.getForTenant(
      execution.context.tenantId,
      execution.context.accountId,
    );
    if (!account || account.status !== 'active' || !hasExactAgentDwsProfile(account)
      || account.profileId !== execution.context.profileId) {
      throw new Error('DWS context account is unavailable or unauthorized');
    }
    const principal = principalFor(account);
    const remote = await this.options.resolveServerRemote(principal);
    const transport = this.options.transportFactory
      ? this.options.transportFactory(remote)
      : new HttpTransport(remote);
    const root = resolveDwsPrincipalCwd(this.options.agentCwd, principal);
    const mountSubPath = deriveAgentWorkspaceMountSubPath(this.options.agentCwd, root);
    if (!mountSubPath) throw new Error('无法解析 Agent DWS connector workspace 挂载路径');
    const workspaceId = deriveDwsPrincipalWorkspaceId(principal);
    const command = args.map(shellQuote).join(' ');
    const response = await transport.invoke({
      toolName: 'Shell',
      input: { command, timeoutMs: DWS_CONTEXT_COMMAND_TIMEOUT_MS },
      context: {
        invocationId: `agent-dws-context-${randomUUID()}`,
        workspace: {
          id: workspaceId,
          root,
          userId: account.accountId,
          username: account.displayName,
          tenantId: account.tenantId,
          sessionId: `agent-dws-context-${account.accountId}`,
          sandboxScopeId: `${workspaceId}__dws_context`,
          mountSubPath,
          executionTarget: 'server-remote',
          workload: { class: 'cron' },
          sandboxResources: DWS_CONNECTOR_SANDBOX_RESOURCES,
        },
      },
    });
    if (response.status === 'error') {
      throw new Error(redactRemoteError(response.error, remote.authToken, execution.env));
    }
    try {
      return JSON.parse(response.content.trim());
    } catch {
      throw new Error('DWS context command did not return valid JSON');
    }
  }
}

async function ensureContextResources(
  store: ContextStore,
  assignmentStore: ContextCollectionAssignmentStore | undefined,
  account: AgentDwsAccountRecord,
  source: ContextSyncSource,
): Promise<void> {
  const key: ContextSyncKey = { ...scopeFor(account), source };
  const identity = defaultPartitionIdentity(key);
  const policy = contextPolicyJson(contextPolicyFor(account));
  let contextSource = await store.getSource(account.tenantId, identity.sourceId);
  if (!contextSource) {
    try {
      contextSource = await store.createSource({
        tenantId: account.tenantId,
        sourceId: identity.sourceId,
        kind: 'dws',
        displayName: account.displayName,
        config: {
          accountId: account.accountId,
          accountRevision: account.revision,
          profileId: account.profileId!,
          contextPolicy: policy,
        },
      });
    } catch (error) {
      if (!(error instanceof ContextStoreError) || error.code !== 'CONTEXT_IDENTITY_CONFLICT') throw error;
      contextSource = await store.getSource(account.tenantId, identity.sourceId);
      if (!contextSource) throw error;
    }
  }
  const desiredSourceConfig = {
    ...contextSource.config,
    accountId: account.accountId,
    accountRevision: account.revision,
    profileId: account.profileId!,
    contextPolicy: policy,
  };
  const desiredStatus = account.status === 'active' ? 'active' : 'disabled';
  if (!sameJson(contextSource.config, desiredSourceConfig) || contextSource.status !== desiredStatus) {
    contextSource = await store.updateSource({
      tenantId: account.tenantId,
      sourceId: identity.sourceId,
      expectedRevision: contextSource.revision,
      config: desiredSourceConfig,
      status: desiredStatus,
    });
  }

  let collection = await store.getCollection(account.tenantId, identity.sourceId, identity.collectionId);
  const initialMetadata = collectionPolicyMetadata(source, {}, contextPolicyFor(account));
  if (!collection) {
    try {
      collection = await store.createCollection({
        tenantId: account.tenantId,
        sourceId: identity.sourceId,
        collectionId: identity.collectionId,
        externalKey: source,
        displayName: collectionName(source),
        metadata: initialMetadata,
      });
    } catch (error) {
      if (!(error instanceof ContextStoreError) || error.code !== 'CONTEXT_IDENTITY_CONFLICT') throw error;
      collection = await store.getCollection(account.tenantId, identity.sourceId, identity.collectionId);
      if (!collection) throw error;
    }
  }
  const accountPolicy = contextPolicyFor(account);
  const desiredMetadata = collectionPolicyMetadata(source, collection.metadata, accountPolicy);
  const desiredCollectionStatus = desiredStatus === 'active' && sourceEnabled(source, accountPolicy)
    ? 'active'
    : 'disabled';
  if (!sameJson(collection.metadata, desiredMetadata) || collection.status !== desiredCollectionStatus) {
    collection = await store.updateCollection({
      tenantId: account.tenantId,
      sourceId: identity.sourceId,
      collectionId: identity.collectionId,
      expectedRevision: collection.revision,
      metadata: desiredMetadata,
      status: desiredCollectionStatus,
    });
  }
  if (assignmentStore && !await assignmentStore.getAssignmentSet(
    account.tenantId,
    'org_knowledge',
    identity.collectionId,
  )) {
    try {
      // Provision an explicit, empty assignment set. It appears in governance UI
      // but grants nobody access until an administrator chooses a scope.
      await assignmentStore.replaceAssignments(
        account.tenantId,
        'org_knowledge',
        identity.collectionId,
        [],
        0,
        'system:context-sync',
        { resourceName: `${account.displayName} · ${collectionName(source)}`, status: 'enabled' },
      );
    } catch (error) {
      if (!await assignmentStore.getAssignmentSet(account.tenantId, 'org_knowledge', identity.collectionId)) {
        throw error;
      }
    }
  }
}

function periodicTargets(
  account: AgentDwsAccountRecord,
  sources: readonly ContextSyncSource[] = SOURCES,
): RuntimeSyncTarget[] {
  const targets: RuntimeSyncTarget[] = [];
  const policy = contextPolicyFor(account);
  for (const source of sources) {
    if (source === 'wiki') {
      if (policy.wiki?.enabled === true) targets.push({ source });
      continue;
    }
    if (source === 'minutes') {
      if (policy.minutes?.enabled === true) {
        targets.push({ source, lookbackDays: policy.minutes.lookbackDays });
      }
      continue;
    }
    const historicalConversations = policy.historical.mode === 'selected'
      ? [...new Set(policy.historical.conversationIds)].sort()
      : [];
    if (policy.historical.mode === 'all') {
      targets.push({ source: 'chat', lookbackDays: policy.historical.lookbackDays });
      continue;
    }
    if (historicalConversations.length > 0) {
      targets.push({
        source: 'chat',
        conversationIds: historicalConversations,
        lookbackDays: policy.historical.lookbackDays,
      });
    }
    const realtimeInitialFrom = earliestRealtimeConsent(policy, policy.realtime.conversationIds)
      ?? account.updatedAt;
    if (policy.realtime.mode === 'all') {
      targets.push({ source: 'chat', initialFrom: realtimeInitialFrom });
      continue;
    }
    if (policy.realtime.mode === 'selected') {
      const historicalSet = new Set(historicalConversations);
      const realtimeOnly = [...new Set(policy.realtime.conversationIds)]
        .filter(conversationId => !historicalSet.has(conversationId))
        .sort();
      if (realtimeOnly.length > 0) {
        targets.push({ source: 'chat', conversationIds: realtimeOnly, initialFrom: realtimeInitialFrom });
      }
    }
  }
  return targets;
}

function contextPolicyFor(account: AgentDwsAccountRecord): AgentDwsContextPolicy {
  return account.contextPolicy ?? failClosedAgentDwsContextPolicy();
}

function selectionAllows(selection: AgentDwsContextPolicySelection, conversationId: string): boolean {
  return selection.mode === 'all'
    || (selection.mode === 'selected' && selection.conversationIds.includes(conversationId));
}

function earliestRealtimeConsent(
  policy: AgentDwsContextPolicy,
  conversationIds: readonly string[],
): string | undefined {
  if (policy.realtime.mode === 'all') {
    return policy.realtimeEffectiveAt?.all ?? policy.effectiveAt;
  }
  const timestamps = conversationIds
    .map(conversationId => policy.realtimeEffectiveAt?.conversations?.[conversationId])
    .filter((value): value is string => Boolean(value));
  if (timestamps.length === 0) return policy.effectiveAt;
  return timestamps.reduce((left, right) => Date.parse(left) <= Date.parse(right) ? left : right);
}

function eventInitialFrom(timestamp: number | undefined, now: Date): string {
  if (Number.isFinite(timestamp)) {
    const raw = Number(timestamp);
    const millis = raw > 0 && raw < 1_000_000_000_000 ? raw * 1_000 : raw;
    const bounded = Math.min(millis, now.getTime());
    if (Number.isFinite(bounded) && bounded >= 0) return new Date(bounded).toISOString();
  }
  return new Date(Math.max(0, now.getTime() - 60_000)).toISOString();
}

function contextPolicyJson(policy: AgentDwsContextPolicy) {
  return {
    historical: {
      mode: policy.historical.mode,
      conversationIds: [...policy.historical.conversationIds],
      lookbackDays: policy.historical.lookbackDays,
    },
    realtime: {
      mode: policy.realtime.mode,
      conversationIds: [...policy.realtime.conversationIds],
    },
    wiki: { enabled: policy.wiki?.enabled === true },
    minutes: {
      enabled: policy.minutes?.enabled === true,
      lookbackDays: policy.minutes?.lookbackDays ?? 30,
    },
    ...(policy.realtimeEffectiveAt ? { realtimeEffectiveAt: policy.realtimeEffectiveAt } : {}),
    ...(policy.effectiveAt ? { effectiveAt: policy.effectiveAt } : {}),
  };
}

function sourceEnabled(source: ContextSyncSource, policy: AgentDwsContextPolicy): boolean {
  if (source === 'chat') {
    return policy.historical.mode !== 'none' || policy.realtime.mode !== 'none';
  }
  return source === 'wiki' ? policy.wiki?.enabled === true : policy.minutes?.enabled === true;
}

function collectionPolicyMetadata(
  source: ContextSyncSource,
  existing: Record<string, unknown>,
  policy: AgentDwsContextPolicy,
) {
  if (source === 'chat') return chatCollectionMetadata(existing, policy);
  const enabled = source === 'wiki'
    ? policy.wiki?.enabled === true
    : policy.minutes?.enabled === true;
  return {
    ...existing,
    historicalLearning: {
      enabled,
      lookbackDays: source === 'minutes' ? policy.minutes?.lookbackDays ?? 30 : null,
    },
    realtimeListening: { enabled: false },
  };
}

function chatCollectionMetadata(
  existing: Record<string, unknown>,
  policy: AgentDwsContextPolicy,
) {
  const contextPolicy = contextPolicyJson(policy);
  return {
    ...existing,
    contextPolicy,
    historicalLearning: {
      enabled: policy.historical.mode !== 'none',
      mode: policy.historical.mode,
      conversationIds: [...policy.historical.conversationIds],
      lookbackDays: policy.historical.lookbackDays,
    },
    realtimeListening: {
      enabled: policy.realtime.mode !== 'none',
      mode: policy.realtime.mode,
      conversationIds: [...policy.realtime.conversationIds],
    },
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function scopeFor(account: AgentDwsAccountRecord): ContextSyncScope {
  return { tenantId: account.tenantId, accountId: account.accountId, profileId: account.profileId! };
}

function isMessageWake(type: string): boolean {
  return type === 'user_im_message_receive_at' || type === 'user_im_message_receive_o2o_all';
}

function collectionName(source: ContextSyncSource): string {
  if (source === 'chat') return '钉钉聊天';
  if (source === 'wiki') return '钉钉文档';
  return '钉钉听记';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function redactRemoteError(
  error: unknown,
  authToken: string,
  env?: Readonly<Record<string, string>>,
): string {
  let text = error instanceof Error ? error.message : String(error ?? 'unknown_error');
  for (const secret of [authToken, ...Object.values(env ?? {})]) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return compactError(text);
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|client_secret|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'unknown_error';
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}
