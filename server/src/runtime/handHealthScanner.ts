import type { HandRecord, HandStore, HandStatus, WorkspaceRecipe } from './handStore.js';
import type { EventStore } from './types.js';

/**
 * B4: HandHealthScanner — 周期对 `server-remote` hands 调 `${endpoint}/health`，
 * 失败时把 `status` 从 `ready` 翻成 `unhealthy`，恢复时翻回 `ready`，并写
 * `hand_health_changed` 事件让 audit 可追溯。
 *
 * 设计取舍：
 * - **只扫 server-remote**：server-local / server-container / client hand 各
 *   自有专属健康通路（in-process / docker-cli / reverse WS heartbeat），不归
 *   本 scanner 管。
 * - **status 收敛逻辑**：只在状态翻转时写库 + emit event；保持 ready 时只更新
 *   `lastHealthCheckOkAt` metadata，避免每 30s 一轮的写入风暴。
 * - **重试驱动**：unhealthy hand 若缓存了 WorkspaceRecipe，会按 metadata.provision
 *   retryPolicy 到期后 best-effort replay `/provision`，成功后收敛回 ready。
 * - **并发**：每轮 max in-flight = handCount（典型 ≤ 数十个），单次 health
 *   调用本身受 healthTimeoutMs 限制。
 */

export interface HandHealthScannerOptions {
  handStore: HandStore;
  eventStore?: EventStore;
  intervalMs?: number;
  /** 单次 /health 请求超时。默认 5s。 */
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Resolve a hand record's bearer token (tenant hand) or fall back to the
   * configured serverRemote token. Returns undefined → scanner skips the hand
   * with a single warn log per cycle.
   */
  resolveHandAuthToken?: (hand: HandRecord) => string | undefined | Promise<string | undefined>;
  /** Static serverRemote bearer for non-tenant hands. */
  defaultServerRemoteAuthToken?: string;
  /** Enable replaying cached WorkspaceRecipe for unhealthy hands. Default true. */
  enableReprovision?: boolean;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export class HandHealthScanner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly intervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private inFlight = false;

  constructor(private readonly options: HandHealthScannerOptions) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.scanOnce(); }, this.intervalMs);
    this.timer.unref?.();
    this.options.logger?.info(`HandHealthScanner started: intervalMs=${this.intervalMs} healthTimeoutMs=${this.healthTimeoutMs}`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Exposed for tests and ad-hoc admin scans. Skips itself when a previous scan
   * is still in flight (slow KMS / DNS shouldn't pile up overlapping scans).
   */
  async scanOnce(): Promise<{ scanned: number; flipped: number }> {
    if (this.inFlight) return { scanned: 0, flipped: 0 };
    this.inFlight = true;
    try {
      const store = this.options.handStore;
      if (!store.listByType) {
        this.options.logger?.warn('HandHealthScanner: HandStore.listByType is missing; scanner is a no-op');
        return { scanned: 0, flipped: 0 };
      }
      const ready = await store.listByType('server-remote', { status: 'ready' });
      const unhealthy = await store.listByType('server-remote', { status: 'unhealthy' });
      const candidates = [...ready, ...unhealthy];
      let flipped = 0;
      for (const hand of candidates) {
        const targetStatus = await this.probe(hand);
        if (!targetStatus) continue;
        if (targetStatus !== hand.status) {
          await store.updateStatus(hand.handId, targetStatus, {
            lastHealthCheckAt: new Date().toISOString(),
            ...(targetStatus === 'unhealthy' ? {} : { recoveredAt: new Date().toISOString() }),
          });
          await this.appendHealthEvent(hand, targetStatus);
          flipped += 1;
          this.options.logger?.info(
            `HandHealthScanner: handId=${hand.handId} ${hand.status} → ${targetStatus}`,
          );
          continue;
        }
        if (targetStatus === 'unhealthy' && hand.status === 'unhealthy') {
          const reprovisioned = await this.reprovisionIfDue(hand);
          if (reprovisioned) flipped += 1;
        }
      }
      return { scanned: candidates.length, flipped };
    } finally {
      this.inFlight = false;
    }
  }

  private async probe(hand: HandRecord): Promise<HandStatus | undefined> {
    if (!hand.endpoint) {
      // No endpoint to probe — leave status alone but record metadata for ops.
      return undefined;
    }
    const authToken = await this.resolveToken(hand);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${hand.endpoint.replace(/\/$/, '')}/health`, {
        headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
        signal: controller.signal,
      });
      if (!response.ok) return 'unhealthy';
      const body = await response.json().catch(() => ({} as Record<string, unknown>));
      return (body as { status?: string }).status === 'ok' ? 'ready' : 'unhealthy';
    } catch {
      return 'unhealthy';
    } finally {
      clearTimeout(timer);
    }
  }


  private async reprovisionIfDue(hand: HandRecord): Promise<boolean> {
    if (this.options.enableReprovision === false) return false;
    if (!hand.endpoint) return false;
    const recipe = parseCachedRecipe(hand.metadata?.recipe, hand.workspaceId);
    if (!recipe) return false;
    const provision = parseProvisionMetadata(hand.metadata?.provision);
    const now = Date.now();
    if (provision.nextAttemptAt && Date.parse(provision.nextAttemptAt) > now) return false;
    if (provision.attempts >= provision.maxAttempts) return false;

    const attempt = provision.attempts + 1;
    const authToken = await this.resolveToken(hand);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${hand.endpoint.replace(/\/$/, '')}/provision`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ workspaceId: recipe.workspaceId, recipe }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
      if (response.ok && body.status === 'ok') {
        await this.options.handStore.updateStatus(hand.handId, 'ready', {
          provision: {
            attempts: 0,
            lastStatus: 'ok',
            lastAttemptAt: new Date(now).toISOString(),
            lastSucceededAt: new Date().toISOString(),
            ...(body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : {}),
          },
        });
        await this.appendHealthEvent(hand, 'ready', 'reprovision_succeeded');
        this.options.logger?.info(`HandHealthScanner: reprovision succeeded handId=${hand.handId}`);
        return true;
      }
      await this.recordReprovisionFailure(hand, attempt, body.error, body.metadata);
      return false;
    } catch (err) {
      await this.recordReprovisionFailure(hand, attempt, controller.signal.aborted ? `provision timeout (${this.healthTimeoutMs}ms)` : err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async recordReprovisionFailure(hand: HandRecord, attempt: number, error: unknown, metadata?: unknown): Promise<void> {
    const base = parseProvisionMetadata(hand.metadata?.provision);
    const retryPolicy = parseRetryPolicy(metadata) ?? { maxAttempts: base.maxAttempts, backoffMs: base.backoffMs };
    const delayMs = retryPolicy.backoffMs[Math.min(attempt - 1, retryPolicy.backoffMs.length - 1)] ?? 15_000;
    await this.options.handStore.updateStatus(hand.handId, 'unhealthy', {
      provision: {
        attempts: attempt,
        lastStatus: 'error',
        lastAttemptAt: new Date().toISOString(),
        lastError: typeof error === 'string' ? error : 'hand reprovision failed',
        nextAttemptAt: attempt >= retryPolicy.maxAttempts ? undefined : new Date(Date.now() + delayMs).toISOString(),
        retryPolicy,
      },
    });
    if (hand.sessionId) {
      await this.options.eventStore?.append({
        type: 'hand_failure',
        sessionId: hand.sessionId,
        workspaceId: hand.workspaceId,
        handId: hand.handId,
        error: typeof error === 'string' ? error : 'hand reprovision failed',
        classifiedAs: 'unhealthy',
      }).catch(() => undefined);
    }
  }

  private async resolveToken(hand: HandRecord): Promise<string | undefined> {
    const tenantToken = await this.options.resolveHandAuthToken?.(hand);
    if (tenantToken) return tenantToken;
    return this.options.defaultServerRemoteAuthToken;
  }

  private async appendHealthEvent(hand: HandRecord, newStatus: HandStatus, detail?: string): Promise<void> {
    const eventStore = this.options.eventStore;
    if (!eventStore) return;
    if (!hand.sessionId) return;
    await eventStore.append({
      type: 'hand_health_changed',
      sessionId: hand.sessionId,
      handId: hand.handId,
      workspaceId: hand.workspaceId,
      status: newStatus,
      detail: detail ?? (newStatus === 'unhealthy' ? 'health_probe_failed' : 'health_probe_recovered'),
    }).catch(() => undefined);
  }
}


function parseCachedRecipe(value: unknown, expectedWorkspaceId: string): WorkspaceRecipe | null {
  if (!value || typeof value !== 'object') return null;
  const recipe = value as WorkspaceRecipe;
  if (typeof recipe.workspaceId !== 'string' || recipe.workspaceId !== expectedWorkspaceId) return null;
  return recipe;
}

function parseProvisionMetadata(value: unknown): { attempts: number; maxAttempts: number; backoffMs: number[]; nextAttemptAt?: string } {
  const obj = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const retryPolicy = parseRetryPolicy(obj.retryPolicy) ?? { maxAttempts: 3, backoffMs: [1000, 5000, 15000] };
  return {
    attempts: typeof obj.attempts === 'number' && Number.isFinite(obj.attempts) ? Math.max(0, Math.floor(obj.attempts)) : 0,
    maxAttempts: retryPolicy.maxAttempts,
    backoffMs: retryPolicy.backoffMs,
    ...(typeof obj.nextAttemptAt === 'string' ? { nextAttemptAt: obj.nextAttemptAt } : {}),
  };
}

function parseRetryPolicy(value: unknown): { maxAttempts: number; backoffMs: number[] } | null {
  if (!value || typeof value !== 'object') return null;
  const outer = value as Record<string, unknown>;
  const obj = outer.retryPolicy && typeof outer.retryPolicy === 'object' ? outer.retryPolicy as Record<string, unknown> : outer;
  const rawBackoff = Array.isArray(obj.backoffMs) ? obj.backoffMs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0) : [];
  return {
    maxAttempts: typeof obj.maxAttempts === 'number' && Number.isFinite(obj.maxAttempts) ? Math.max(1, Math.floor(obj.maxAttempts)) : 3,
    backoffMs: rawBackoff.length ? rawBackoff : [1000, 5000, 15000],
  };
}
