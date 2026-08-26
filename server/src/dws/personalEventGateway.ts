import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import { HttpTransport } from '../runtime/httpTransport.js';
import type { DwsWorkspacePrincipal } from './authFlow.js';
import { deriveDwsPrincipalWorkspaceId, resolveDwsPrincipalCwd } from './authFlow.js';
import { principalFor } from './agentAuthFlow.js';

const EVENT_STREAM_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_LINE_BUFFER = 1024 * 1024;
const MAX_SEEN_EVENTS = 10_000;
const RUNTIME_LEASE_TTL_MS = 60_000;
const RUNTIME_LEASE_RENEW_MS = 20_000;
const RUNTIME_RECONCILE_MS = 30_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 60 * 60_000;

export interface DwsRetryState {
  failures: number;
  nextAttemptAt: number;
  circuitOpenUntil?: number;
  lastError: string;
}

export interface DwsPersonalEvent {
  type: string;
  eventId: string;
  conversationId?: string;
  messageId?: string;
  senderOpenDingtalkId?: string;
  senderName?: string;
  content?: string;
  timestamp?: number;
  raw: Record<string, unknown>;
}

export class DwsPersonalEventGateway {
  private readonly active = new Map<string, { controller: AbortController; leaseOwner: string; task: Promise<void> }>();
  private reconcileTimer?: NodeJS.Timeout;
  private readonly retryByAccount = new Map<string, DwsRetryState>();
  private stopped = false;

  constructor(private readonly options: {
    agentCwd: string;
    accountStore: AgentDwsAccountStore;
    resolveServerRemote: (principal: DwsWorkspacePrincipal) => Promise<{
      baseUrl: string;
      authToken: string;
      invokeTimeoutMs?: number;
    }>;
    onEvent?: (account: AgentDwsAccountRecord, event: DwsPersonalEvent) => Promise<void>;
    isExecutionEnabled?: () => boolean | Promise<boolean>;
    now?: () => number;
    logger?: { info(message: string): void; warn(message: string): void };
  }) {}

  async startAll(): Promise<void> {
    if (this.stopped) return;
    await this.reconcile();
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch(error => {
        this.options.logger?.warn(`Agent DWS runtime reconcile failed: ${compactError(error)}`);
      });
    }, RUNTIME_RECONCILE_MS);
    this.reconcileTimer.unref?.();
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    if (this.options.isExecutionEnabled && !await this.options.isExecutionEnabled()) {
      const entries = [...this.active.values()];
      for (const active of entries) active.controller.abort();
      await Promise.all(entries.map(active => active.task.catch(() => undefined)));
      return;
    }
    const accounts = await this.options.accountStore.listRunnable();
    await Promise.all(accounts.map(account => this.startAccount(account)));
  }

  async startAccount(account: AgentDwsAccountRecord): Promise<void> {
    if (this.stopped || account.status !== 'active' || !account.profileId) return;
    if (this.options.isExecutionEnabled && !await this.options.isExecutionEnabled()) return;
    if (this.active.has(account.accountId)) return;
    const retry = this.retryByAccount.get(account.accountId);
    if (retry && Math.max(retry.nextAttemptAt, retry.circuitOpenUntil ?? 0) > this.now()) return;
    const leaseOwner = `agent-dws-stream:${randomUUID()}`;
    const controller = new AbortController();
    const task = (async () => {
      const claimed = await this.options.accountStore.claimRuntimeLease(
        account.accountId,
        leaseOwner,
        RUNTIME_LEASE_TTL_MS,
      );
      if (!claimed) return;
      if (controller.signal.aborted || this.stopped) {
        await this.options.accountStore.releaseRuntimeLease(account.accountId, leaseOwner);
        return;
      }
      await this.consume(account, leaseOwner, controller);
    })()
      .catch(error => {
        this.options.logger?.warn(
          `Agent DWS event stream task failed account=${account.accountId}: ${compactError(error)}`,
        );
      })
      .finally(async () => {
        await this.options.accountStore.releaseRuntimeLease(account.accountId, leaseOwner).catch(error => {
          this.options.logger?.warn(
            `Agent DWS runtime lease release failed account=${account.accountId}: ${compactError(error)}`,
          );
        });
        if (this.active.get(account.accountId)?.controller === controller) {
          this.active.delete(account.accountId);
        }
      });
    this.active.set(account.accountId, { controller, leaseOwner, task });
  }

  async stopTenant(tenantId: string): Promise<void> {
    const accounts = await this.options.accountStore.listForTenant(tenantId);
    await Promise.all(accounts.map(account => this.stopAccount(account.accountId)));
  }

  async stopAccount(accountId: string): Promise<void> {
    const active = this.active.get(accountId);
    try {
      await this.options.accountStore.revokeRuntimeLease(accountId);
    } finally {
      active?.controller.abort();
      await active?.task.catch(() => undefined);
      this.active.delete(accountId);
      this.retryByAccount.delete(accountId);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    const entries = [...this.active.entries()];
    for (const [, active] of entries) active.controller.abort();
    await Promise.all(entries.map(async ([accountId, active]) => {
      await active.task.catch(() => undefined);
      await this.options.accountStore.releaseRuntimeLease(accountId, active.leaseOwner).catch(() => undefined);
    }));
    this.active.clear();
  }

  private async consume(
    account: AgentDwsAccountRecord,
    leaseOwner: string,
    controller: AbortController,
  ): Promise<void> {
    const principal = principalFor(account);
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      void this.options.accountStore.renewRuntimeLease(
        account.accountId,
        leaseOwner,
        RUNTIME_LEASE_TTL_MS,
      ).then(renewed => {
        if (!renewed) {
          this.options.logger?.warn(`Agent DWS runtime lease lost account=${account.accountId}`);
          controller.abort();
        }
      }).catch(error => {
        this.options.logger?.warn(
          `Agent DWS runtime lease renewal failed account=${account.accountId}: ${compactError(error)}`,
        );
        controller.abort();
      }).finally(() => {
        renewing = false;
      });
    }, RUNTIME_LEASE_RENEW_MS);
    heartbeat.unref?.();
    try {
      await this.options.accountStore.updateRuntimeStatus(account.accountId, 'starting', undefined, leaseOwner);
      const remote = await this.options.resolveServerRemote(principal);
      const transport = new HttpTransport({
        baseUrl: remote.baseUrl,
        authToken: remote.authToken,
        invokeTimeoutMs: Math.max(remote.invokeTimeoutMs ?? 0, EVENT_STREAM_TIMEOUT_MS + 10_000),
      });
      const root = resolveDwsPrincipalCwd(this.options.agentCwd, principal);
      const mountSubPath = deriveWorkspaceMountSubPath(this.options.agentCwd, root);
      if (!mountSubPath) throw new Error('无法解析 Agent DWS connector workspace 挂载路径');
      const workspaceId = deriveDwsPrincipalWorkspaceId(principal);
      const invocationId = `agent-dws-events-${account.accountId}`;
      const command = eventCommand(account);
      let stdoutBuffer = '';
      const seen = new Set<string>();
      let finalError: string | undefined;

      // 上一次 stream 若异常断开，先按稳定 invocationId 精确收口旧执行。
      // PG lease 保证此时没有另一位合法 owner；ACS 侧的同 ID 门禁再挡竞态。
      await transport.cancelInvocation(invocationId);
      for await (const chunk of transport.invokeStream({
        toolName: 'Shell',
        input: { command, timeoutMs: EVENT_STREAM_TIMEOUT_MS },
        context: {
          invocationId,
          signal: controller.signal,
          workspace: {
            id: workspaceId,
            root,
            userId: account.accountId,
            username: account.displayName,
            tenantId: account.tenantId,
            sessionId: `agent-dws-events-${account.accountId}`,
            sandboxScopeId: `${workspaceId}__dws_events`,
            mountSubPath,
            executionTarget: 'server-remote',
          },
        },
      })) {
        if (chunk.type === 'output' && chunk.channel === 'stderr') {
          if (chunk.content.includes('[event] ready')) {
            this.retryByAccount.delete(account.accountId);
            await this.options.accountStore.updateRuntimeStatus(account.accountId, 'ready', undefined, leaseOwner);
            this.options.logger?.info(`Agent DWS event stream ready account=${account.accountId}`);
          }
          continue;
        }
        if (chunk.type === 'output' && chunk.channel === 'stdout') {
          stdoutBuffer = `${stdoutBuffer}${chunk.content}`;
          if (stdoutBuffer.length > MAX_LINE_BUFFER) throw new Error('DWS 事件输出行超过 1 MiB');
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const event = parseEventLine(line);
            if (!event || seen.has(event.eventId)) continue;
            seen.add(event.eventId);
            if (seen.size > MAX_SEEN_EVENTS) seen.delete(seen.values().next().value!);
            const leaseValid = await this.options.accountStore.markEvent(account.accountId, leaseOwner);
            if (!leaseValid) {
              controller.abort();
              return;
            }
            await this.options.onEvent?.(account, event);
          }
          continue;
        }
        if (chunk.type === 'completed' && chunk.response.status === 'error') {
          finalError = chunk.response.error || 'DWS 事件流异常结束';
        }
      }
      if (!controller.signal.aborted) throw new Error(finalError || 'DWS 事件流已结束');
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = compactError(error);
      const retry = this.recordFailure(account.accountId, message);
      await this.options.accountStore.updateRuntimeStatus(
        account.accountId,
        'error',
        message,
        leaseOwner,
      ).catch(statusError => {
        this.options.logger?.warn(
          `Agent DWS runtime status update failed account=${account.accountId}: ${compactError(statusError)}`,
        );
      });
      this.options.logger?.warn(
        `Agent DWS event stream failed account=${account.accountId}: ${message}; failures=${retry.failures} `
        + `nextAttemptAt=${new Date(retry.nextAttemptAt).toISOString()}`
        + (retry.circuitOpenUntil ? ` circuitOpenUntil=${new Date(retry.circuitOpenUntil).toISOString()}` : ''),
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  getRetrySnapshot(): Record<string, DwsRetryState> {
    return Object.fromEntries([...this.retryByAccount.entries()].map(([accountId, state]) => [accountId, { ...state }]));
  }

  private recordFailure(accountId: string, message: string): DwsRetryState {
    const failures = (this.retryByAccount.get(accountId)?.failures ?? 0) + 1;
    const delayMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
    const now = this.now();
    const circuitOpenUntil = failures >= CIRCUIT_FAILURE_THRESHOLD ? now + CIRCUIT_OPEN_MS : undefined;
    const state: DwsRetryState = {
      failures,
      nextAttemptAt: circuitOpenUntil ?? now + delayMs,
      ...(circuitOpenUntil ? { circuitOpenUntil } : {}),
      lastError: message,
    };
    this.retryByAccount.set(accountId, state);
    return state;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function eventCommand(account: AgentDwsAccountRecord): string {
  const keys = account.eventKinds.map(kind => (
    kind === 'at_me' ? 'user_im_message_receive_at' : 'user_im_message_receive_o2o_all'
  ));
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) throw new Error('Agent DWS 账号未配置事件类型');
  const lockKey = createHash('sha256').update(account.accountId).digest('hex').slice(0, 24);
  return `flock --no-fork --nonblock --conflict-exit-code 75 /tmp/agent-dws-events-${lockKey}.lock `
    + `dws event consume ${uniqueKeys.join(' ')} --flatten -f ndjson --profile ${shellQuote(account.profileId!)}`;
}

export function parseEventLine(line: string): DwsPersonalEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const eventId = text(raw.event_id);
  const type = text(raw.type) ?? text(raw.event_type);
  const senderName = text(raw.sender_name) ?? text(raw.sender_nick);
  if (!eventId || !type) return null;
  return {
    type,
    eventId,
    ...(text(raw.conversation_id) ? { conversationId: text(raw.conversation_id) } : {}),
    ...(text(raw.message_id) ? { messageId: text(raw.message_id) } : {}),
    ...(text(raw.sender_open_dingtalk_id) ? { senderOpenDingtalkId: text(raw.sender_open_dingtalk_id) } : {}),
    ...(senderName ? { senderName } : {}),
    ...(text(raw.content) ? { content: text(raw.content) } : {}),
    ...(number(raw.timestamp) !== undefined ? { timestamp: number(raw.timestamp) } : {}),
    raw,
  };
}

function deriveWorkspaceMountSubPath(agentCwd: string, workspaceRoot: string): string | undefined {
  const mountRoot = resolve(agentCwd, '..');
  const rel = relative(mountRoot, resolve(workspaceRoot));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'unknown_error';
}
