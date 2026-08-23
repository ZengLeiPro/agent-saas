import { randomUUID } from 'node:crypto';

import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../../data/agentDwsAccounts/index.js';
import { principalFor } from '../../dws/agentAuthFlow.js';
import {
  deriveDwsPrincipalWorkspaceId,
  resolveDwsPrincipalCwd,
  type DwsWorkspacePrincipal,
} from '../../dws/authFlow.js';
import type { DwsPersonalEvent } from '../../dws/personalEventGateway.js';
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
import type { ContextSyncKey, ContextSyncScope, ContextSyncSource } from './types.js';

const DWS_CONTEXT_COMMAND_TIMEOUT_MS = 120_000;
const DWS_CONTEXT_INITIAL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;
const DWS_CONTEXT_TICK_MS = 60_000;
const SOURCE_INTERVAL_MS: Readonly<Record<ContextSyncSource, number>> = {
  chat: 2 * 60_000,
  minutes: 30 * 60_000,
  wiki: 60 * 60_000,
};
const SOURCES: readonly ContextSyncSource[] = ['chat', 'minutes', 'wiki'];

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
    if (account.status !== 'active' || !account.profileId || !event.conversationId
      || !isMessageWake(event.type)) return;
    // Use the same account-level partition as periodic chat sync. This preserves
    // one durable retry key; the event body itself remains non-authoritative.
    try {
      await this.syncSource(account, 'chat');
    } catch (error) {
      this.dueAt.set(this.dueKey(account, 'chat'), this.clock().getTime() + this.tickMs);
      throw error;
    }
  }

  /** Public for tests/diagnostics and post-auth backfill. */
  async syncAccount(
    account: AgentDwsAccountRecord,
    sources: readonly ContextSyncSource[] = SOURCES,
  ): Promise<void> {
    if (account.status !== 'active' || !account.profileId) return;
    for (const source of sources) {
      try {
        await this.syncSource(account, source);
      } catch (error) {
        // Re-enter quickly; syncSource will read the durable nextRetryAt and
        // either replay the exact failed window or sleep until it is due.
        this.dueAt.set(this.dueKey(account, source), this.clock().getTime() + this.tickMs);
        this.options.logger?.warn?.(
          `DWS context sync failed account=${safeId(account.accountId)} source=${source}: ${compactError(error)}`,
        );
      }
    }
  }

  private async syncSource(
    account: AgentDwsAccountRecord,
    source: ContextSyncSource,
  ): Promise<void> {
    const service = await this.serviceFor(account, source);
    const key: ContextSyncKey = { ...this.scope(account), source };
    const retry = await service.getRetryState(key);
    if (retry) {
      const retryAt = Date.parse(retry.nextAttemptAt);
      if (Number.isFinite(retryAt) && retryAt > this.clock().getTime()) {
        this.dueAt.set(this.dueKey(account, source), retryAt);
        return;
      }
      await service.retry(key);
    } else {
      await service.syncWindow({ scope: this.scope(account), source, to: this.clock().toISOString() });
    }
    this.dueAt.set(this.dueKey(account, source), this.clock().getTime() + SOURCE_INTERVAL_MS[source]);
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
      const sources = SOURCES.filter(source => (this.dueAt.get(this.dueKey(account, source)) ?? 0) <= now);
      if (sources.length > 0) await this.syncAccount(account, sources);
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
    return new DwsContextSyncService({
      store: new ContextStoreSyncAdapter({ store: this.options.contextStore }),
      client: new DwsCliContextClient({
        executor,
        ...(this.options.logger?.warn ? {
          logger: { warn: (message: string) => this.options.logger?.warn?.(message) },
        } : {}),
      }),
      clock: this.clock,
      defaultLookbackMs: this.initialLookbackMs,
    });
  }

  private scope(account: AgentDwsAccountRecord): ContextSyncScope {
    return {
      tenantId: account.tenantId,
      accountId: account.accountId,
      profileId: account.profileId!,
    };
  }

  private dueKey(account: AgentDwsAccountRecord, source: ContextSyncSource): string {
    return `${account.tenantId}\0${account.accountId}\0${source}`;
  }
}

interface DwsRemoteJsonExecutorOptions {
  agentCwd: string;
  accountStore: AgentDwsAccountStore;
  resolveServerRemote: DwsContextServerRemoteResolver;
  transportFactory?: DwsContextRuntimeOptions['transportFactory'];
}

/** Executes deterministic DWS argv in the account's isolated connector workspace. */
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
    if (!account || account.status !== 'active' || !account.profileId
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
  if (!await store.getSource(account.tenantId, identity.sourceId)) {
    try {
      await store.createSource({
        tenantId: account.tenantId,
        sourceId: identity.sourceId,
        kind: 'dws',
        displayName: account.displayName,
        config: { accountId: account.accountId, profileId: account.profileId! },
      });
    } catch (error) {
      if (!(error instanceof ContextStoreError) || error.code !== 'CONTEXT_IDENTITY_CONFLICT'
        || !await store.getSource(account.tenantId, identity.sourceId)) throw error;
    }
  }
  if (!await store.getCollection(account.tenantId, identity.sourceId, identity.collectionId)) {
    try {
      await store.createCollection({
        tenantId: account.tenantId,
        sourceId: identity.sourceId,
        collectionId: identity.collectionId,
        externalKey: source,
        displayName: collectionName(source),
        metadata: {
          historicalLearning: { enabled: true, lookbackDays: Math.floor(DWS_CONTEXT_INITIAL_LOOKBACK_MS / 86_400_000) },
          realtimeListening: { enabled: source === 'chat' },
        },
      });
    } catch (error) {
      if (!(error instanceof ContextStoreError) || error.code !== 'CONTEXT_IDENTITY_CONFLICT'
        || !await store.getCollection(account.tenantId, identity.sourceId, identity.collectionId)) throw error;
    }
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
