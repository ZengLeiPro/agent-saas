import { createHash, randomUUID } from 'node:crypto';
import {
  type TerminalDeferredState,
  type TerminalLifecycleCandidate,
} from './sandboxTerminalOutboxStore.js';
export type { TerminalDeferredState } from './sandboxTerminalOutboxStore.js';
import type { PlatformEvent } from './types.js';
import type { HandStore } from './handStore.js';
import type { RunStore } from './runStore.js';
import type { SessionCatalog } from './sessionCatalog.js';
import { PgSandboxLifecycleStore, type CleanupCandidate } from './sandboxLifecycleStore.js';
export { PgSandboxLifecycleStore } from './sandboxLifecycleStore.js';
import { deriveSandboxScopeId, deriveWorkspaceMountSubPath, type TenantRemoteHandDispatchConfig } from './rawRuntimeRunDispatch.js';
import { runtimeRunController } from './runController.js';
import { controlPlaneFetch } from './controlPlaneFetch.js';
import { selectTenantRemoteHandsForRegistration, type TenantRemoteHandAuthTokenResolver } from './tenantRemoteHandResolver.js';

export interface SandboxLifecycleIdentity {
  workspaceId: string;
  sessionId: string;
  sandboxScopeId: string;
}

interface SandboxDeletionGenerationUpdate extends SandboxLifecycleIdentity {
  deletionGeneration: string;
  previousDeletionGeneration?: string;
}

interface SandboxScopeDeletion extends SandboxLifecycleIdentity {
  deletionGeneration: string;
}

export type SandboxDeletionResult =
  | 'not_required'
  | 'blocked'
  | 'queued'
  | 'deleted';

export interface SandboxLifecycleLogger {
  info(message: string): void;
  warn(message: string): void;
}

export class AcsSandboxLifecycleClient {
  constructor(private readonly options: {
    baseUrl: string;
    authToken: string;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
  }) {}

  async notifyTerminal(input: SandboxLifecycleIdentity & {
    terminalState: 'completed' | 'failed' | 'cancelled' | 'timed-out';
    terminalAt: string;
    outcome?: unknown;
    expectedActivityGeneration?: string | null;
  }): Promise<void> {
    await this.request('/sandboxes/lifecycle', 'POST', input, undefined, false);
  }

  async readLifecycleFence(input: SandboxLifecycleIdentity): Promise<string | null> {
    const response = await this.request('/sandboxes/lifecycle-fence', 'POST', input, undefined, false);
    if (!response || typeof response !== 'object' || !('activityGeneration' in response))
      throw new Error('ACS lifecycle fence response is invalid');
    const generation = (response as { activityGeneration?: unknown }).activityGeneration;
    if (generation !== null && typeof generation !== 'string') throw new Error('ACS lifecycle fence generation is invalid');
    return generation;
  }

  async advanceDeletionGeneration(input: SandboxDeletionGenerationUpdate, signal?: AbortSignal): Promise<void> {
    await this.request('/sandboxes/deletion-generation', 'POST', input, signal, true);
  }

  async deleteScope(input: SandboxScopeDeletion, signal?: AbortSignal): Promise<void> {
    await this.request('/sandboxes/scope', 'DELETE', input, signal, true);
  }

  private async request(
    path: string,
    method: 'POST' | 'DELETE',
    body: unknown,
    externalSignal: AbortSignal | undefined,
    allowMissing: boolean,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 5_000);
    timer.unref?.();
    try {
      const baseUrl = this.options.baseUrl.replace(/\/$/, '');
      const response = await controlPlaneFetch(baseUrl, this.options.fetchImpl)(`${baseUrl}${path}`, {
        method, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.authToken}` },
        body: JSON.stringify(body), signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal,
      });
      if (response.ok) return await response.json().catch(() => ({}));
      const text = await response.text().catch(() => '');
      if (allowMissing && response.status === 404 && /Sandbox .*not found|lifecycle identity not found/i.test(text)) return;
      throw new Error(`ACS ${method} ${path} HTTP ${response.status}: ${text.slice(0, 300) || 'no body'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class SandboxLifecycleService {
  private timer?: NodeJS.Timeout;
  private scanPromise: Promise<void> | undefined;
  private readonly cleanupInFlight = new Map<string, {
    sessionId: string;
    controller: AbortController;
    promise: Promise<void>;
  }>();

  constructor(private readonly options: {
    agentCwd: string;
    store: PgSandboxLifecycleStore;
    runStore: Pick<RunStore, 'cancelSteeringBeforeDispatchBySessionWithEvent'>;
    sessionCatalog: Pick<SessionCatalog, 'get'>;
    handStore?: Pick<HandStore, 'get' | 'listBySession'>;
    tenantRemoteHands: () => TenantRemoteHandDispatchConfig[] | undefined;
    tenantRemoteHandResolver: TenantRemoteHandAuthTokenResolver;
    serverRemote?: { baseUrl: string; authToken: string; authTokenRef?: string };
    resolveServerRemoteAuthToken?: (authTokenRef: string) => Promise<string>;
    logger?: SandboxLifecycleLogger;
    fetchImpl?: typeof fetch;
    scanIntervalMs?: number;
    now?: () => Date;
  }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), this.options.scanIntervalMs ?? 15_000);
    this.timer.unref?.();
    this.wake();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  observeRuntimeEvent(event: PlatformEvent): void {
    if (event.type === 'run_finished' || event.type === 'background_task_finished') this.wake();
  }

  wake(): void {
    if (this.scanPromise) return;
    this.scanPromise = this.scan().catch((error) => {
      this.options.logger?.warn(`sandbox_lifecycle_scan_failed error=${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { this.scanPromise = undefined; });
  }

  async cancelSessionDeletion(sessionId: string): Promise<void> {
    const record = await this.options.sessionCatalog.get(sessionId);
    const deletionGeneration = newDeletionGeneration();
    const cancelled = await this.options.store.cancelCleanup(sessionId, record?.tenantId, deletionGeneration);
    const inFlight = [...this.cleanupInFlight.values()].filter((delivery) => delivery.sessionId === sessionId);
    for (const delivery of inFlight) {
      delivery.controller.abort(new Error('sandbox cleanup cancelled by session restore'));
    }
    for (const cleanup of cancelled) {
      const target = await this.resolveClient(cleanup.sessionId, cleanup.tenantId, undefined, cleanup);
      if (!target) throw new Error(`Sandbox cleanup target hand unavailable: ${cleanup.targetHandId}`);
      await target.client.advanceDeletionGeneration(cleanup);
    }
    if (cancelled.length === 0) {
      const target = await this.resolveSessionTarget(sessionId);
      if (target) await target.client.advanceDeletionGeneration({ ...target.identity, deletionGeneration });
    }
    await Promise.all(inFlight.map((delivery) => delivery.promise.catch(() => undefined)));
  }

  async prepareSessionDeletionIntent(sessionId: string): Promise<Exclude<SandboxDeletionResult, 'deleted'>> {
    try {
      const record = await this.options.sessionCatalog.get(sessionId);
      // Hidden subagents share their parent's scope; this proves they never independently owned an ACS Sandbox.
      if (record?.kind === 'subagent') return 'not_required';
      if (!record) return 'blocked';
      const resolved = await this.resolveSessionTarget(sessionId);
      if (!resolved) return 'blocked';
      const {
        identity, tenantId, userId, username, targetHandId,
        serverRemoteEndpoint, serverRemoteAuthTokenRef,
      } = resolved;
      const enqueued = await this.options.store.enqueueCleanup({
        ...identity, targetHandId, deletionGeneration: newDeletionGeneration(),
        ...(serverRemoteEndpoint ? { serverRemoteEndpoint } : {}),
        ...(serverRemoteAuthTokenRef ? { serverRemoteAuthTokenRef } : {}),
        ...(tenantId ? { tenantId } : {}), ...(userId ? { userId } : {}), ...(username ? { username } : {}),
      }, { prepared: true }); // prepared 不可投递，先避免 tombstone 前产生外部删除。
      if (!enqueued) return 'blocked';
      return 'queued';
    } catch (error) {
      this.options.logger?.warn(`sandbox_cleanup_intent_blocked session=${sessionId} error=${error instanceof Error ? error.message : String(error)}`);
      return 'blocked';
    }
  }

  async commitPreparedSessionDeletion(sessionId: string, options?: { waitForDeletion?: boolean }): Promise<SandboxDeletionResult> {
    let prepared = (await this.options.store.listPreparedCleanupCandidates()).filter((item) => item.sessionId === sessionId);
    let pending = (await this.options.store.listCleanupCandidates()).filter((item) => item.sessionId === sessionId);
    const intent: Exclude<SandboxDeletionResult, 'deleted'> = prepared.length > 0 || pending.length > 0
      ? 'queued'
      : await this.prepareSessionDeletionIntent(sessionId);
    if (prepared.length === 0 && pending.length === 0 && intent === 'queued') {
      prepared = (await this.options.store.listPreparedCleanupCandidates()).filter((item) => item.sessionId === sessionId);
    }
    for (const candidate of prepared) await this.processPreparedCleanup(candidate);
    // 软删除只等待持久化取消；远端容器回收交给可重试的清理队列。
    if (options?.waitForDeletion === false) {
      if (intent === 'queued') this.wake();
      return intent;
    }
    pending = (await this.options.store.listCleanupCandidates()).filter((item) => item.sessionId === sessionId);
    for (const candidate of pending) {
      try {
        if (await this.deliverCleanupCandidate(candidate)) return 'deleted';
      } catch (error) {
        this.warnCandidate('sandbox_cleanup_queued', candidate.runId, error);
        this.wake();
      }
    }
    if (intent === 'not_required' || intent === 'blocked') return intent;
    return 'queued';
  }

  async prepareSessionDeletion(sessionId: string): Promise<SandboxDeletionResult> {
    return this.commitPreparedSessionDeletion(sessionId);
  }

  private async listScannerCandidates<T>(event: string, list: () => Promise<T[]>): Promise<T[]> {
    try {
      return await list();
    } catch (error) {
      this.warnCandidate(event, 'scanner', error);
      return [];
    }
  }

  private async scan(): Promise<void> {
    const preparedCandidates = await this.listScannerCandidates(
      'sandbox_cleanup_prepare_list_failed', async () => (await this.options.store.listPreparedCleanupCandidates?.()) ?? [],
    );
    for (const prepared of preparedCandidates) {
      try {
        await this.processPreparedCleanup(prepared);
      } catch (error) {
        this.warnCandidate('sandbox_cleanup_prepare_failed', prepared.runId, error);
      }
    }
    const legacyCandidates = await this.listScannerCandidates(
      'sandbox_cleanup_legacy_list_failed', async () => (await this.options.store.listLegacyCleanupCandidates?.()) ?? [],
    );
    for (const legacy of legacyCandidates) {
      try {
        const resolved = await this.resolveSessionTarget(legacy.sessionId);
        if (!resolved) continue;
        const { runId: legacyRunId, ...legacyIdentity } = legacy;
        await this.options.store.enqueueCleanup({
          ...legacyIdentity, legacyRunId,
          targetHandId: resolved.targetHandId, deletionGeneration: newDeletionGeneration(),
          ...(resolved.serverRemoteEndpoint ? { serverRemoteEndpoint: resolved.serverRemoteEndpoint } : {}),
          ...(resolved.serverRemoteAuthTokenRef
            ? { serverRemoteAuthTokenRef: resolved.serverRemoteAuthTokenRef }
            : {}),
        });
      } catch (error) {
        this.warnCandidate('sandbox_cleanup_legacy_failed', legacy.runId, error);
      }
    }
    const pendingCandidates = await this.listScannerCandidates(
      'sandbox_cleanup_retry_list_failed', () => this.options.store.listCleanupCandidates(),
    );
    for (const pending of pendingCandidates) {
      try {
        await this.deliverCleanupCandidate(pending);
      } catch (error) {
        this.warnCandidate('sandbox_cleanup_retry_failed', pending.runId, error);
      }
    }
    const terminalCandidates = await this.listScannerCandidates(
      'sandbox_terminal_list_failed', () => this.options.store.listTerminalCandidates(),
    );
    for (const candidate of terminalCandidates) {
      try {
        if (await this.options.store.hasActivity(candidate)) {
          await this.deferTerminalCandidate(candidate.runId, new Error('sandbox scope still has activity'));
          continue;
        }
        let targetHandId = candidate.targetHandId;
        if (!targetHandId) {
          const original = await this.resolveSessionTarget(candidate.sessionId);
          if (!original) {
            await this.deferTerminalCandidate(candidate.runId, new Error('sandbox lifecycle target is unresolved'));
            continue;
          }
          targetHandId = await this.options.store.pinTerminalTargetHand(candidate.runId, original.targetHandId);
        }
        if (!targetHandId) {
          await this.deferTerminalCandidate(candidate.runId, new Error('sandbox lifecycle target hand is missing'));
          continue;
        }
        const target = await this.resolveClient(candidate.sessionId, candidate.tenantId, undefined, { targetHandId });
        if (!target) {
          await this.deferTerminalCandidate(candidate.runId, new Error(`sandbox lifecycle target unavailable: ${targetHandId}`));
          continue;
        }
        const lifecycleIdentity = {
          workspaceId: candidate.workspaceId, sessionId: candidate.sessionId,
          sandboxScopeId: candidate.sandboxScopeId,
        };
        const timedOut = candidate.status === 'failed' && /timed?\s*out|timeout/i.test(candidate.statusReason ?? '');
        const commit = await this.options.store.runWhileTerminalCandidateCurrent(candidate, async (terminalAt) => {
          const expectedActivityGeneration = await target.client.readLifecycleFence(lifecycleIdentity);
          await target.client.notifyTerminal({
            workspaceId: candidate.workspaceId, sessionId: candidate.sessionId,
            sandboxScopeId: candidate.sandboxScopeId,
            terminalState: timedOut ? 'timed-out' : candidate.status === 'orphaned' ? 'failed' : candidate.status,
            terminalAt, expectedActivityGeneration,
            outcome: { runId: candidate.runId, status: candidate.status, ...(candidate.statusReason ? { reason: candidate.statusReason } : {}) },
          });
        });
        if (commit !== 'committed') {
          await this.deferTerminalCandidate(candidate.runId, new Error(
            commit === 'active' ? 'sandbox scope became active before terminal commit' : 'sandbox terminal candidate was superseded',
          ));
          continue;
        }
      } catch (error) {
        await this.deferTerminalCandidate(candidate.runId, error);
        this.warnCandidate('sandbox_terminal_notify_failed', candidate.runId, error);
      }
    }
  }

  private async processPreparedCleanup(prepared: CleanupCandidate): Promise<void> {
    const record = await this.options.sessionCatalog.get(prepared.sessionId);
    if (!record?.deletedAt) {
      await this.options.store.expireUncommittedPreparedCleanup(prepared.runId);
      return;
    }
    const claimId = randomUUID();
    const claimed = await this.options.store.claimPreparedCleanup(prepared.runId, claimId);
    if (!claimed?.claimGeneration) return;
    const generation = claimed.claimGeneration;
    const ownsClaim = () => this.options.store.isPreparedCleanupClaimCurrent(claimed.runId, claimId, generation);
    try {
      const confirmed = await this.options.sessionCatalog.get(claimed.sessionId);
      if (!confirmed?.deletedAt || !await ownsClaim()) {
        await this.options.store.releasePreparedCleanupClaim(claimed.runId, claimId, generation);
        return;
      }
      if (!await this.cancelScope(claimed, claimed.tenantId, ownsClaim)) {
        await this.options.store.releasePreparedCleanupClaim(claimed.runId, claimId, generation);
        return;
      }
      const completed = await this.options.store.completePreparedCleanup(claimed.runId, claimId, generation);
      if (!completed) {
        await this.options.store.releasePreparedCleanupClaim(claimed.runId, claimId, generation);
        this.wake();
      }
    } catch (error) {
      await this.options.store.releasePreparedCleanupClaim(claimed.runId, claimId, generation);
      throw error;
    }
  }

  private async deliverCleanupCandidate(pending: CleanupCandidate): Promise<boolean> {
    const claimId = randomUUID();
    const cleanup = await this.options.store.claimCleanup(pending.runId, claimId);
    if (!cleanup) return false;
    try {
      const target = await this.resolveClient(cleanup.sessionId, cleanup.tenantId, undefined, cleanup);
      if (!target) return false;
      return await this.deliverClaimedCleanup(cleanup, target.client);
    } finally {
      await this.options.store.releaseCleanupClaim(cleanup.runId, claimId);
    }
  }

  private currentTime(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async deferTerminalCandidate(runId: string, error: unknown): Promise<void> {
    try {
      await this.options.store.deferTerminalCandidate?.(runId, error, this.currentTime().toISOString());
    } catch (deferError) {
      this.warnCandidate('sandbox_terminal_defer_failed', runId, deferError);
    }
  }

  private warnCandidate(event: string, runId: string, error: unknown): void {
    this.options.logger?.warn(`${event} run=${runId} error=${error instanceof Error ? error.message : String(error)}`);
  }

  // Delivery claim checks bracket every external transition; durable CAS remains final authority.
  private async deliverClaimedCleanup(cleanup: CleanupCandidate, client: AcsSandboxLifecycleClient): Promise<boolean> {
    const claimId = cleanup.claimId;
    if (!claimId || !await this.options.store.isCleanupClaimCurrent(cleanup.runId, claimId)) return false;
    const controller = new AbortController();
    const promise = (async () => {
      if (!await this.options.store.isCleanupClaimCurrent(cleanup.runId, claimId)) return;
      await client.advanceDeletionGeneration(cleanup, controller.signal);
      if (!await this.options.store.isCleanupClaimCurrent(cleanup.runId, claimId)) return;
      await client.deleteScope(cleanup, controller.signal);
      if (!await this.options.store.isCleanupClaimCurrent(cleanup.runId, claimId)) return;
      await this.options.store.markCleanupDelivered(cleanup.runId, claimId, new Date().toISOString());
    })();
    this.cleanupInFlight.set(claimId, { sessionId: cleanup.sessionId, controller, promise });
    try {
      await promise;
      return !controller.signal.aborted;
    } finally {
      if (this.cleanupInFlight.get(claimId)?.promise === promise) this.cleanupInFlight.delete(claimId);
    }
  }

  private async cancelScope(
    identity: CleanupCandidate, tenantId?: string,
    ownsClaim: () => Promise<boolean> = async () => true,
  ): Promise<boolean> {
    const cancel = this.options.runStore.cancelSteeringBeforeDispatchBySessionWithEvent;
    while (await ownsClaim()) {
      const active = await this.options.store.listActiveScopeRuns(identity, tenantId);
      if (active.length === 0) return ownsClaim();
      if (!cancel) throw new Error('Runtime scope cancellation is unavailable');
      for (const run of active) {
        if (!run.tenantId) throw new Error(`Runtime Run tenant 缺失，拒绝删除 scope：${run.runId}`);
        const reason = `session_deleted:${identity.sessionId}`;
        await cancel.call(this.options.runStore, run.sessionId, reason, run.runId, {
          type: 'run_cancel_requested', sessionId: run.sessionId, runId: run.runId,
          ...(run.userId ? { userId: run.userId } : {}), reason,
        }, run.tenantId, {
          cleanupRunId: identity.runId, sessionId: identity.sessionId,
          sandboxScopeId: identity.sandboxScopeId,
          claimId: identity.claimId!, claimGeneration: identity.claimGeneration!,
        });
        if (!await ownsClaim()) return false;
        runtimeRunController.abort(run.runId, reason);
      }
    }
    return false;
  }

  private async resolveSessionTarget(sessionId: string): Promise<{
    identity: SandboxLifecycleIdentity;
    tenantId?: string;
    userId?: string;
    username?: string;
    targetHandId: string;
    client: AcsSandboxLifecycleClient;
    serverRemoteEndpoint?: string;
    serverRemoteAuthTokenRef?: string;
  } | undefined> {
    const record = await this.options.sessionCatalog.get(sessionId);
    if (!record || record.kind === 'subagent') return undefined;
    const hand = record.tenantId
      ? await this.options.handStore?.get(`${sessionId}:server-remote`, record.tenantId)
      : undefined;
    const registeredServerRemoteEndpoint = hand?.providerId === 'server-remote'
      ? stringValue(hand.endpoint)
      : undefined;
    const registeredServerRemoteAuthTokenRef = hand?.providerId === 'server-remote'
      ? stringValue(hand.metadata?.serverRemoteAuthTokenRef)
      : undefined;
    const pinnedTargetHandId = stringValue(hand?.metadata?.tenantRemoteHandId);
    const registeredHands = pinnedTargetHandId
      ? []
      : record.tenantId ? await this.options.handStore?.listBySession(sessionId, record.tenantId).catch(() => []) : [];
    const registeredIds = registeredHands
      ?.map((registered) => stringValue(registered.metadata?.tenantRemoteHandId) ?? stringValue(registered.providerId));
    const registeredTargetHandId = pinnedTargetHandId
      ?? registeredIds?.find((id) => id === 'agent-saas-acs')
      ?? registeredIds?.find((id) => id && /acs/i.test(id))
      ?? (this.options.serverRemote && hand?.providerId === 'server-remote'
        ? serverRemoteTargetHandId(registeredServerRemoteEndpoint ?? this.options.serverRemote.baseUrl)
        : undefined);
    const target = await this.resolveClient(
      sessionId,
      record.tenantId,
      record,
      registeredTargetHandId ? {
        targetHandId: registeredTargetHandId,
        ...(registeredServerRemoteEndpoint ? { serverRemoteEndpoint: registeredServerRemoteEndpoint } : {}),
        ...(registeredServerRemoteAuthTokenRef
          ? { serverRemoteAuthTokenRef: registeredServerRemoteAuthTokenRef }
          : {}),
      } : undefined,
    );
    if (!target) return undefined;
    const workspaceId = record.workspaceId ?? sessionId;
    const recipe = asRecord(asRecord(hand?.metadata).recipe);
    const mountSubPath = stringValue(recipe.mountSubPath)
      ?? deriveWorkspaceMountSubPath({ agentCwd: this.options.agentCwd, cwd: record.cwd });
    const sandboxScopeId = stringValue(recipe.sandboxScopeId)
      ?? deriveSandboxScopeId({ workspaceId, mountSubPath, topLevelSessionId: sessionId });
    return {
      identity: { workspaceId, sessionId, sandboxScopeId },
      ...(record.tenantId ? { tenantId: record.tenantId } : {}),
      ...(record.userId ? { userId: record.userId } : {}),
      ...(record.username ? { username: record.username } : {}),
      targetHandId: target.targetHandId,
      client: target.client,
      ...(registeredServerRemoteEndpoint ? { serverRemoteEndpoint: registeredServerRemoteEndpoint } : {}),
      ...(registeredServerRemoteAuthTokenRef
        ? { serverRemoteAuthTokenRef: registeredServerRemoteAuthTokenRef }
        : {}),
    };
  }

  private async resolveClient(
    sessionId: string,
    tenantId?: string,
    knownRecord?: Awaited<ReturnType<SessionCatalog['get']>>,
    routing?: {
      userId?: string;
      username?: string;
      targetHandId?: string;
      serverRemoteEndpoint?: string;
      serverRemoteAuthTokenRef?: string;
    },
  ): Promise<{ client: AcsSandboxLifecycleClient; targetHandId: string } | undefined> {
    if (routing?.targetHandId === 'server-remote') return undefined;
    const record = knownRecord ?? await this.options.sessionCatalog.get(sessionId);
    const configured = this.options.tenantRemoteHands() ?? [];
    const entry = routing?.targetHandId
      ? configured.find((hand) => hand.id === routing.targetHandId)
      : (() => {
          const selector = {
            userId: record?.userId ?? routing?.userId,
            username: record?.username ?? routing?.username,
            userTenantId: tenantId ?? record?.tenantId,
          };
          const candidates = selectTenantRemoteHandsForRegistration(configured, selector);
          return candidates.find((hand) => hand.id === 'agent-saas-acs')
            ?? candidates.find((hand) => /acs/i.test(hand.id));
        })();
    if (entry) {
      const resolved = await this.options.tenantRemoteHandResolver.resolveForRegister(entry);
      return {
        targetHandId: entry.id,
        client: new AcsSandboxLifecycleClient({
          baseUrl: resolved.baseUrl, authToken: resolved.authToken, fetchImpl: this.options.fetchImpl,
        }),
      };
    }
    if (!this.options.serverRemote || !routing?.targetHandId) return undefined;
    const registeredHand = routing.serverRemoteEndpoint
      ? undefined
      : tenantId ? await this.options.handStore?.get(`${sessionId}:server-remote`, tenantId).catch(() => undefined) : undefined;
    const registeredEndpoint = routing.serverRemoteEndpoint
      ?? (registeredHand?.providerId === 'server-remote' ? stringValue(registeredHand.endpoint) : undefined);
    const registeredAuthTokenRef = routing.serverRemoteAuthTokenRef
      ?? (registeredHand?.providerId === 'server-remote'
        ? stringValue(registeredHand.metadata?.serverRemoteAuthTokenRef)
        : undefined);
    const currentTargetHandId = serverRemoteTargetHandId(this.options.serverRemote.baseUrl);
    const targetIsCurrent = routing.targetHandId === currentTargetHandId;
    const endpoint = targetIsCurrent ? this.options.serverRemote.baseUrl : registeredEndpoint;
    if (!endpoint || serverRemoteTargetHandId(endpoint) !== routing.targetHandId) return undefined;
    let authToken = this.options.serverRemote.authToken;
    if (!targetIsCurrent) {
      if (!registeredAuthTokenRef || !this.options.resolveServerRemoteAuthToken) return undefined;
      authToken = await this.options.resolveServerRemoteAuthToken(registeredAuthTokenRef);
    }
    return {
      targetHandId: routing.targetHandId,
      client: new AcsSandboxLifecycleClient({
        baseUrl: endpoint,
        authToken,
        fetchImpl: this.options.fetchImpl,
      }),
    };
  }
}

function serverRemoteTargetHandId(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/u, '');
  const endpointHash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `server-remote:${endpointHash}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function newDeletionGeneration(nowMs = Date.now()): string {
  return `${Math.trunc(nowMs)}-${randomUUID()}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
