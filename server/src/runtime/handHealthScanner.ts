import { randomUUID } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';

import {
  hasUnresolvedHandProvisionFailure,
  type HandRecord,
  type HandStore,
  type HandStatus,
  type WorkspaceRecipe,
} from './handStore.js';
import { assertRuntimeIsolationEvidence } from './runtimeIsolationEvidence.js';
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
 *   retryPolicy 到期后 best-effort replay `/provision`；单轮耗尽后冷却再开新周期，
 *   成功后才收敛回 ready。
 * - **恢复限流**：健康探测按 endpoint/token 合并；session-specific `/provision`
 *   每轮最多发起固定数量，避免大面积故障恢复时形成 provision 风暴。
 */

export interface HandHealthScannerOptions {
  handStore: HandStore;
  eventStore?: EventStore;
  intervalMs?: number;
  /** 单次 /health 请求超时。默认 5s。 */
  healthTimeoutMs?: number;
  /** 单次 session-specific /provision 请求超时。默认 4min，与健康探针分离。 */
  provisionTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 仅供可信 loopback Hand 控制面使用，绕过全局出站代理包装。 */
  loopbackFetchImpl?: typeof fetch;
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
  /** 达到单轮 maxAttempts 后再次开启重试周期的冷却时间。默认 10min。 */
  exhaustedRetryCooldownMs?: number;
  /** 单次 scan 最多发起多少个 session-specific /provision，避免恢复风暴。默认 10。 */
  maxReprovisionAttemptsPerScan?: number;
  /**
   * 历史恢复允许 ACS 已存在的 Pending Sandbox 上限。未配置时不探测容量；
   * 生产设为 0，确保任何新会话正在启动时都不会继续注入历史恢复请求。
   */
  maxPendingSandboxesForReprovision?: number;
  isExecutionEnabled?: () => boolean | Promise<boolean>;
  /**
   * ready→unhealthy 翻转前的二次确认间隔（毫秒），默认 5s。
   * 2026-07-15 零停机部署批次：orchestrator drain 重启有 5-15s 连接拒绝空窗，
   * 单次探测失败即翻 unhealthy 会触发 fail-closed，把空窗放大成最长 30s+
   * 的工具不可用；间隔复检一次仍失败才翻转。unhealthy→ready 保持单次即翻（尽快恢复）。
   */
  unhealthyConfirmDelayMs?: number;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

function requireHandTenantId(hand: HandRecord): string {
  const tenantId = hand.tenantId?.trim();
  if (!tenantId) throw new Error(`Hand health event tenant is missing for ${hand.handId}`);
  return tenantId;
}

export class HandHealthScanner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly intervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly provisionTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly loopbackFetchImpl: typeof fetch;
  private readonly unhealthyConfirmDelayMs: number;
  private readonly exhaustedRetryCooldownMs: number;
  private readonly maxReprovisionAttemptsPerScan: number;
  private readonly maxPendingSandboxesForReprovision: number | undefined;
  private inFlight = false;
  private reprovisionAttemptsThisScan = 0;
  private readonly recoveryCapacityBlocksThisScan = new Set<string>();

  constructor(private readonly options: HandHealthScannerOptions) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 5_000;
    this.provisionTimeoutMs = options.provisionTimeoutMs ?? 4 * 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.loopbackFetchImpl = options.loopbackFetchImpl ?? (undiciFetch as unknown as typeof fetch);
    this.unhealthyConfirmDelayMs = options.unhealthyConfirmDelayMs ?? 5_000;
    this.exhaustedRetryCooldownMs = options.exhaustedRetryCooldownMs ?? 10 * 60_000;
    this.maxReprovisionAttemptsPerScan = options.maxReprovisionAttemptsPerScan ?? 10;
    this.maxPendingSandboxesForReprovision = options.maxPendingSandboxesForReprovision;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scanOnce().catch((error) => {
        this.options.logger?.error(`HandHealthScanner scan failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.intervalMs);
    this.timer.unref?.();
    this.options.logger?.info(
      `HandHealthScanner started: intervalMs=${this.intervalMs} healthTimeoutMs=${this.healthTimeoutMs} provisionTimeoutMs=${this.provisionTimeoutMs}`,
    );
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
   *
   * 2026-08-03 CPU 治理 P0b：按 `endpoint + authToken` 去重探测。
   * 生产事实：hands 记录是 per-session 累积（`${sessionId}:server-remote`），
   * 900+ 条记录几乎全部指向同一个 orchestrator endpoint。旧实现逐 hand 串行
   * probe（每次 ~1.1s），一轮 15min+ >> 30s interval，`inFlight` 防重叠后退化
   * 为 7×24 连续 ~1 QPS 打 /health——这是 ACS ECS 约一核 CPU 的调用侧根因。
   * 现在同一 (endpoint, token) 组只 probe 一次（含 ready→unhealthy 的二次
   * 确认也按组做），结果 fan-out 到组内所有 hand；翻转写库/事件仍逐 hand。
   */
  async scanOnce(): Promise<{ scanned: number; flipped: number }> {
    if (this.inFlight) return { scanned: 0, flipped: 0 };
    if (this.options.isExecutionEnabled && !await this.options.isExecutionEnabled()) return { scanned: 0, flipped: 0 };
    this.inFlight = true;
    this.reprovisionAttemptsThisScan = 0;
    this.recoveryCapacityBlocksThisScan.clear();
    try {
      const store = this.options.handStore;
      if (!store.listByType) {
        this.options.logger?.warn('HandHealthScanner: HandStore.listByType is missing; scanner is a no-op');
        return { scanned: 0, flipped: 0 };
      }
      const ready = await store.listByType('server-remote', { status: 'ready' });
      const unhealthy = await store.listByType('server-remote', { status: 'unhealthy' });
      const candidates = [...ready, ...unhealthy];

      // 按 (endpoint, authToken) 分组。token 参与 key：同 endpoint 不同凭据的
      // 探测结果可能不同（401 → unhealthy）。resolveToken 对非 tenant hand 是
      // 纯内存短路（metadata 无 tenantRemoteHandId → default token），无额外开销。
      const groups = new Map<string, { endpoint: string; authToken?: string; hands: HandRecord[] }>();
      let flipped = 0;
      for (const scannedHand of candidates) {
        let hand = scannedHand;
        if (hand.status === 'ready' && hasUnresolvedHandProvisionFailure(hand)) {
          // endpoint/token 即使不可用，数据库状态也必须先收敛为 unhealthy。PG 实现
          // 用 unresolved marker 条件原子 claim，避免与正常 provision 成功互相覆盖。
          const recoveryToken = randomUUID();
          const claimed = await this.claimProvisionRecovery(hand, recoveryToken, {
            lastHealthCheckAt: new Date().toISOString(),
          });
          if (claimed) {
            const converged = await this.completeProvisionRecovery(
              claimed,
              recoveryToken,
              'unhealthy',
              { lastHealthCheckAt: new Date().toISOString() },
            );
            hand = converged ?? await store.get(hand.handId) ?? hand;
            if (converged) {
              await this.appendHealthEvent(scannedHand, 'unhealthy', 'provision_failure_pending');
              flipped += 1;
            }
          } else {
            hand = await store.get(hand.handId) ?? hand;
          }
        }
        if (!hand.endpoint) continue;
        let authToken: string | undefined;
        try {
          authToken = await this.resolveToken(hand);
        } catch {
          this.options.logger?.warn(`HandHealthScanner: auth token unavailable for handId=${hand.handId}; skipping probe`);
          continue;
        }
        const key = `${hand.endpoint}\u0000${authToken ?? ''}`;
        const group = groups.get(key);
        if (group) group.hands.push(hand);
        else groups.set(key, { endpoint: hand.endpoint, authToken, hands: [hand] });
      }

      for (const group of groups.values()) {
        let targetStatus = await this.probeEndpoint(group.endpoint, group.authToken);
        if (targetStatus === 'unhealthy' && group.hands.some((hand) => hand.status === 'ready')) {
          // ready→unhealthy 需间隔复检二次确认（见 unhealthyConfirmDelayMs 注释）
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, this.unhealthyConfirmDelayMs);
            timer.unref?.();
          });
          targetStatus = await this.probeEndpoint(group.endpoint, group.authToken);
        }
        for (const hand of group.hands) {
          // /health 只证明共享 orchestrator 活着，不能证明这个 Session/Sandbox 的
          // /provision 成功。存在 unresolved failure 时必须执行 session-specific
          // reprovision，成功前一律保持 unhealthy，禁止全局健康 fan-out 假恢复。
          if (targetStatus === 'ready' && (
            hand.status === 'unhealthy' || hasUnresolvedHandProvisionFailure(hand)
          )) {
            let recoveryHand = hand;
            if (hand.status !== 'unhealthy') {
              const updated = await this.transitionHandStatus(hand, 'unhealthy', {
                lastHealthCheckAt: new Date().toISOString(),
              });
              if (!updated) continue;
              recoveryHand = updated;
              await this.appendHealthEvent(hand, 'unhealthy', 'provision_failure_pending');
              flipped += 1;
            }
            // 共享 /health 仅证明进程存活；unhealthy Hand 必须通过绑定当前
            // session/workspace 的 /provision 才能恢复，缺 recipe 时保持 fail-closed。
            const reprovisioned = await this.reprovisionIfDue(recoveryHand);
            if (reprovisioned) flipped += 1;
            continue;
          }
          if (targetStatus !== hand.status) {
            const updated = await this.transitionHandStatus(hand, targetStatus, {
              lastHealthCheckAt: new Date().toISOString(),
              ...(targetStatus === 'unhealthy' ? {} : { recoveredAt: new Date().toISOString() }),
            });
            if (!updated) continue;
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
      }
      return { scanned: candidates.length, flipped };
    } finally {
      this.inFlight = false;
    }
  }

  private async probeEndpoint(endpoint: string, authToken: string | undefined): Promise<'ready' | 'unhealthy'> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchEndpoint(endpoint, '/health', {
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

  private async hasRecoveryCapacity(endpoint: string, authToken: string | undefined): Promise<boolean> {
    const limit = this.maxPendingSandboxesForReprovision;
    if (limit === undefined) return true;
    const key = `${endpoint}\u0000${authToken ?? ''}`;
    if (this.recoveryCapacityBlocksThisScan.has(key)) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchEndpoint(endpoint, '/sandboxes', {
        headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json().catch(() => null) as { sandboxes?: Array<{ phase?: unknown }> } | null;
      if (!Array.isArray(body?.sandboxes)) throw new Error('sandboxes payload missing');
      const pending = body.sandboxes.filter((sandbox) => sandbox.phase === 'Pending').length;
      if (pending <= limit) return true;
      this.recoveryCapacityBlocksThisScan.add(key);
      this.options.logger?.info(
        `HandHealthScanner: reprovision capacity blocked pending=${pending} limit=${limit}`,
      );
      return false;
    } catch (error) {
      this.recoveryCapacityBlocksThisScan.add(key);
      this.options.logger?.warn(
        `HandHealthScanner: reprovision capacity probe failed; fail-closed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }


  private async reprovisionIfDue(hand: HandRecord): Promise<boolean> {
    if (this.options.enableReprovision === false) return false;
    if (hand.endpoint) {
      const capacityKey = `${hand.endpoint}\u0000${this.options.defaultServerRemoteAuthToken ?? ''}`;
      if (this.recoveryCapacityBlocksThisScan.has(capacityKey)) return false;
    }
    const latest = await this.options.handStore.get(hand.handId);
    if (latest) {
      if (latest.status === 'ready' && !hasUnresolvedHandProvisionFailure(latest)) return false;
      hand = latest;
    }
    if (!hand.endpoint) return false;
    const endpoint = hand.endpoint;
    const recipe = parseCachedRecipe(hand.metadata?.recipe, hand.workspaceId);
    if (!recipe) return false;
    const provision = parseProvisionMetadata(hand.metadata?.provision);
    const now = Date.now();
    if (provision.nextAttemptAt && Date.parse(provision.nextAttemptAt) > now) return false;
    let attempt = provision.attempts + 1;
    if (provision.attempts >= provision.maxAttempts) {
      const lastAttemptAtMs = provision.lastAttemptAt ? Date.parse(provision.lastAttemptAt) : Number.NaN;
      if (Number.isFinite(lastAttemptAtMs) && lastAttemptAtMs + this.exhaustedRetryCooldownMs > now) return false;
      attempt = 1;
    }
    if (this.reprovisionAttemptsThisScan >= this.maxReprovisionAttemptsPerScan) return false;

    let authToken: string | undefined;
    try {
      authToken = await this.resolveToken(hand);
    } catch {
      this.options.logger?.warn(`HandHealthScanner: auth token unavailable for handId=${hand.handId}; skipping reprovision`);
      return false;
    }
    if (!await this.hasRecoveryCapacity(endpoint, authToken)) return false;
    const recoveryToken = randomUUID();
    const claimed = await this.claimProvisionRecovery(hand, recoveryToken, {
      lastHealthCheckAt: new Date().toISOString(),
    });
    if (!claimed) return false;
    this.reprovisionAttemptsThisScan += 1;
    hand = claimed;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.provisionTimeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchEndpoint(endpoint, '/provision', {
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
        const responseMetadata = recordValue(body.metadata);
        let attestationPatch: Record<string, unknown> = {};
        if (recipe.runtimeIsolationRequirement || hand.metadata?.runtimeIsolationAttested === true) {
          if (!recipe.runtimeIsolationRequirement) {
            await this.recordReprovisionFailure(hand, recoveryToken, attempt, 'RUNTIME_ISOLATION_REQUIREMENT_MISSING', responseMetadata);
            return false;
          }
          const nestedMetadata = responseMetadata.metadata;
          const provisionMetadata = nestedMetadata && typeof nestedMetadata === 'object' && !Array.isArray(nestedMetadata)
            ? nestedMetadata as Record<string, unknown>
            : responseMetadata;
          const verification = {
            requirement: recipe.runtimeIsolationRequirement,
            evidence: provisionMetadata.runtimeIsolationEvidence,
            sandboxScopeId: recipe.sandboxScopeId ?? recipe.workspaceId,
          };
          try {
            assertRuntimeIsolationEvidence(verification);
          } catch (err) {
            await this.recordReprovisionFailure(
              hand,
              recoveryToken,
              attempt,
              err instanceof Error ? err.message : String(err),
              responseMetadata,
            );
            return false;
          }
          attestationPatch = {
            runtimeIsolationAttested: true,
            runId: verification.evidence.runId,
            policyDigest: verification.evidence.policyDigest,
            sandboxName: verification.evidence.sandboxName,
            sandboxScopeId: verification.evidence.sandboxScopeId,
          };
        }
        const completed = await this.completeProvisionRecovery(hand, recoveryToken, 'ready', {
          provisionFailure: null,
          ...attestationPatch,
          provision: {
            attempts: 0,
            lastStatus: 'ok',
            lastAttemptAt: new Date(now).toISOString(),
            lastSucceededAt: new Date().toISOString(),
            ...responseMetadata,
          },
        });
        if (!completed) {
          this.options.logger?.info(`HandHealthScanner: discard stale reprovision success handId=${hand.handId}`);
          return false;
        }
        await this.appendHealthEvent(hand, 'ready', 'reprovision_succeeded');
        this.options.logger?.info(`HandHealthScanner: reprovision succeeded handId=${hand.handId}`);
        return true;
      }
      await this.recordReprovisionFailure(hand, recoveryToken, attempt, body.error, body.metadata);
      return false;
    } catch (err) {
      await this.recordReprovisionFailure(hand, recoveryToken, attempt, controller.signal.aborted ? `provision timeout (${this.provisionTimeoutMs}ms)` : err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async recordReprovisionFailure(
    hand: HandRecord,
    recoveryToken: string,
    attempt: number,
    error: unknown,
    metadata?: unknown,
  ): Promise<void> {
    const base = parseProvisionMetadata(hand.metadata?.provision);
    const retryPolicy = parseRetryPolicy(metadata) ?? { maxAttempts: base.maxAttempts, backoffMs: base.backoffMs };
    const delayMs = attempt >= retryPolicy.maxAttempts
      ? this.exhaustedRetryCooldownMs
      : retryPolicy.backoffMs[Math.min(attempt - 1, retryPolicy.backoffMs.length - 1)] ?? 15_000;
    const failure = typeof error === 'string' ? error : 'hand reprovision failed';
    const completed = await this.completeProvisionRecovery(hand, recoveryToken, 'unhealthy', {
      provisionFailure: failure,
      provision: {
        attempts: attempt,
        lastStatus: 'error',
        lastAttemptAt: new Date().toISOString(),
        lastError: failure,
        nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
        retryPolicy,
      },
    });
    if (!completed) {
      this.options.logger?.info(`HandHealthScanner: discard stale reprovision failure handId=${hand.handId}`);
      return;
    }
    if (hand.sessionId) {
      await this.options.eventStore?.append({
        type: 'hand_failure',
        sessionId: hand.sessionId,
        workspaceId: hand.workspaceId,
        handId: hand.handId,
        error: failure,
        classifiedAs: 'unhealthy',
      }, { tenantId: requireHandTenantId(hand) }).catch(() => undefined);
    }
  }

  private fetchEndpoint(endpoint: string, path: string, init: RequestInit): Promise<Response> {
    let hostname = '';
    try {
      hostname = new URL(endpoint).hostname;
    } catch {
      // 非法 endpoint 继续走受控 fetch，并在原调用路径 fail-closed。
    }
    const fetchImpl = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
      ? this.loopbackFetchImpl
      : this.fetchImpl;
    return fetchImpl(`${endpoint.replace(/\/$/, '')}${path}`, init);
  }

  private async transitionHandStatus(
    hand: HandRecord,
    status: HandStatus,
    metadataPatch: Record<string, unknown>,
  ): Promise<HandRecord | null> {
    const recoveryToken = randomUUID();
    const claimed = await this.claimProvisionRecovery(hand, recoveryToken, {
      lastHealthCheckAt: new Date().toISOString(),
    });
    if (!claimed) return null;
    return await this.completeProvisionRecovery(claimed, recoveryToken, status, metadataPatch);
  }

  private async claimProvisionRecovery(
    hand: HandRecord,
    recoveryToken: string,
    metadataPatch: Record<string, unknown>,
  ): Promise<HandRecord | null> {
    const store = this.options.handStore;
    const provisionGeneration = hand.metadata.provisionGeneration;
    return await store.claimProvisionRecovery(
      hand.handId,
      recoveryToken,
      metadataPatch,
      hand.updatedAt,
      typeof provisionGeneration === 'string' ? provisionGeneration : undefined,
    );
  }

  private async completeProvisionRecovery(
    hand: HandRecord,
    recoveryToken: string,
    status: HandStatus,
    metadataPatch: Record<string, unknown>,
  ): Promise<HandRecord | null> {
    return await this.options.handStore.completeProvisionRecovery(
      hand.handId,
      recoveryToken,
      status,
      metadataPatch,
    );
  }

  private async resolveToken(hand: HandRecord): Promise<string | undefined> {
    const tenantRemoteHandId = hand.metadata?.tenantRemoteHandId;
    if (typeof tenantRemoteHandId === 'string' && tenantRemoteHandId.trim()) {
      const tenantToken = await this.options.resolveHandAuthToken?.(hand);
      if (!tenantToken) throw new Error(`tenant hand auth token unavailable: ${tenantRemoteHandId}`);
      return tenantToken;
    }
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
    }, { tenantId: requireHandTenantId(hand) }).catch(() => undefined);
  }
}


function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseCachedRecipe(value: unknown, expectedWorkspaceId: string): WorkspaceRecipe | null {
  if (!value || typeof value !== 'object') return null;
  const recipe = value as WorkspaceRecipe;
  if (typeof recipe.workspaceId !== 'string' || recipe.workspaceId !== expectedWorkspaceId) return null;
  return recipe;
}

function parseProvisionMetadata(value: unknown): {
  attempts: number;
  maxAttempts: number;
  backoffMs: number[];
  nextAttemptAt?: string;
  lastAttemptAt?: string;
} {
  const obj = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const retryPolicy = parseRetryPolicy(obj.retryPolicy) ?? { maxAttempts: 3, backoffMs: [1000, 5000, 15000] };
  return {
    attempts: typeof obj.attempts === 'number' && Number.isFinite(obj.attempts) ? Math.max(0, Math.floor(obj.attempts)) : 0,
    maxAttempts: retryPolicy.maxAttempts,
    backoffMs: retryPolicy.backoffMs,
    ...(typeof obj.nextAttemptAt === 'string' ? { nextAttemptAt: obj.nextAttemptAt } : {}),
    ...(typeof obj.lastAttemptAt === 'string' ? { lastAttemptAt: obj.lastAttemptAt } : {}),
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
