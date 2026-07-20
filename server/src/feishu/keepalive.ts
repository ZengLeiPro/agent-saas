import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { UserStore } from '../data/users/store.js';
import type { UserInfo } from '../data/users/types.js';
import { HttpTransport } from '../runtime/httpTransport.js';
import { deriveStableWorkspaceId } from '../runtime/workspaceIdentity.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { parseFeishuJson } from './authFlow.js';
import type {
  FeishuAuthCheckResult,
  FeishuConnectionRecord,
  FeishuConnectionStore,
} from './store.js';

const DEFAULT_SCAN_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_INITIAL_DELAY_MS = 45_000;
const DEFAULT_MAX_CHECKS_PER_RUN = 4;
const FEISHU_STATUS_TIMEOUT_MS = 60_000;

export interface FeishuAuthStatusRunnerLike {
  check(user: UserInfo, connection: FeishuConnectionRecord, signal?: AbortSignal): Promise<FeishuAuthCheckResult>;
}

export class FeishuAuthStatusRunner implements FeishuAuthStatusRunnerLike {
  constructor(private readonly options: {
    agentCwd: string;
    resolveServerRemote: (user: UserInfo) => Promise<{
      baseUrl: string;
      authToken: string;
      invokeTimeoutMs?: number;
    }>;
    fetchImpl?: typeof fetch;
  }) {}

  async check(user: UserInfo, connection: FeishuConnectionRecord, signal?: AbortSignal): Promise<FeishuAuthCheckResult> {
    const serverRemote = await this.options.resolveServerRemote(user);
    const transport = new HttpTransport({
      baseUrl: serverRemote.baseUrl,
      authToken: serverRemote.authToken,
      invokeTimeoutMs: Math.max(serverRemote.invokeTimeoutMs ?? 0, FEISHU_STATUS_TIMEOUT_MS + 10_000),
      fetchImpl: this.options.fetchImpl,
    });
    const userCwd = resolveUserCwd(this.options.agentCwd, user);
    const mountSubPath = deriveWorkspaceMountSubPath(this.options.agentCwd, userCwd);
    if (!mountSubPath) throw new Error('无法解析飞书用户工作区挂载路径');
    const workspaceId = deriveStableWorkspaceId(user, `feishu-${user.id}`);
    const response = await transport.invoke({
      toolName: '__FeishuCli',
      input: { operation: 'status', profile: connection.profileId },
      context: {
        invocationId: `feishu-keepalive-${randomUUID()}`,
        signal,
        workspace: {
          id: workspaceId,
          root: userCwd,
          userId: user.id,
          username: user.username,
          tenantId: user.tenantId,
          sessionId: `feishu-keepalive-${user.id}`,
          sandboxScopeId: `${workspaceId}__${mountSubPath.replace(/[^A-Za-z0-9_-]+/g, '_')}`,
          mountSubPath,
          executionTarget: 'server-remote',
        },
      },
    });
    if (response.status === 'error') throw new Error(compactError(response.error));
    const payload = parseFeishuJson(response.content);
    const appId = stringField(payload.appId);
    if (appId && appId !== connection.appId) {
      throw new Error(`飞书应用不匹配：期望 ${connection.appId}，实际 ${appId}`);
    }
    const identities = objectField(payload.identities);
    const userIdentity = objectField(identities?.user);
    const userOpenId = stringField(userIdentity?.openId);
    if (userOpenId && userOpenId !== connection.userOpenId) {
      throw new Error('飞书登录账号与连接记录不匹配');
    }
    const identityStatus = stringField(userIdentity?.status);
    const available = identityStatus === 'available' || userIdentity?.available === true;
    const verified = payload.verified === true || userIdentity?.verified === true;
    return {
      authenticated: available,
      verified,
      ...(stringField(userIdentity?.tokenStatus) ? { tokenStatus: stringField(userIdentity?.tokenStatus) } : {}),
      ...(userOpenId ? { userOpenId } : {}),
      ...(stringField(userIdentity?.userName) ? { userName: stringField(userIdentity?.userName) } : {}),
      ...(stringField(userIdentity?.scope) ? { scope: stringField(userIdentity?.scope) } : {}),
      ...(stringField(userIdentity?.expiresAt) ? { expiresAt: stringField(userIdentity?.expiresAt) } : {}),
      ...(stringField(userIdentity?.refreshExpiresAt) ? { refreshExpiresAt: stringField(userIdentity?.refreshExpiresAt) } : {}),
      ...(!available || !verified
        ? { error: stringField(userIdentity?.message) ?? stringField(payload.verifyError) ?? 'not_authenticated' }
        : {}),
    };
  }
}

export class FeishuAuthKeepaliveService {
  private readonly workerId = `feishu-${process.pid}-${randomUUID()}`;
  private readonly scanIntervalMs: number;
  private readonly initialDelayMs: number;
  private readonly maxChecksPerRun: number;
  private initialTimer?: NodeJS.Timeout;
  private intervalTimer?: NodeJS.Timeout;
  private currentAbort?: AbortController;
  private running = false;
  private stopped = true;

  constructor(private readonly options: {
    userStore: Pick<UserStore, 'findById'>;
    connectionStore: FeishuConnectionStore;
    runner: FeishuAuthStatusRunnerLike;
    scanIntervalMs?: number;
    initialDelayMs?: number;
    maxChecksPerRun?: number;
    logger?: { info(message: string): void; warn(message: string): void };
  }) {
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxChecksPerRun = options.maxChecksPerRun ?? DEFAULT_MAX_CHECKS_PER_RUN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.initialTimer = setTimeout(() => {
      void this.runOnce();
      this.intervalTimer = setInterval(() => void this.runOnce(), this.scanIntervalMs);
      this.intervalTimer.unref?.();
    }, this.initialDelayMs);
    this.initialTimer.unref?.();
    this.options.logger?.info(`Feishu auth keepalive enabled: interval=${this.scanIntervalMs}ms maxChecks=${this.maxChecksPerRun}`);
  }

  stop(): void {
    this.stopped = true;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = undefined;
    this.intervalTimer = undefined;
    this.currentAbort?.abort();
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (let index = 0; index < this.maxChecksPerRun && !this.stopped; index += 1) {
        const connection = await this.options.connectionStore.claimDue(this.workerId, now);
        if (!connection) break;
        await this.checkClaimed(connection, now);
      }
    } catch (err) {
      this.options.logger?.warn(`Feishu auth keepalive scan failed: ${compactError(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async checkClaimed(connection: FeishuConnectionRecord, now: Date): Promise<void> {
    const user = this.options.userStore.findById(connection.userId);
    if (!user || user.disabled || user.tenantId !== connection.tenantId) {
      await this.options.connectionStore.completeCheck(connection, this.workerId, {
        authenticated: false,
        verified: false,
        error: user?.disabled ? 'user_disabled' : 'user_missing',
      }, now);
      return;
    }

    const controller = new AbortController();
    this.currentAbort = controller;
    try {
      const result = await this.options.runner.check(user, connection, controller.signal);
      await this.options.connectionStore.completeCheck(connection, this.workerId, result, now);
      if (!result.authenticated || !result.verified) {
        this.options.logger?.warn(`Feishu auth disconnected user=${user.id} profile=${connection.profileId}`);
      } else {
        this.options.logger?.info(`Feishu auth checked user=${user.id} profile=${connection.profileId}`);
      }
    } catch (err) {
      if (this.stopped && controller.signal.aborted) {
        await this.options.connectionStore.releaseClaim(connection, this.workerId).catch(() => undefined);
        return;
      }
      await this.options.connectionStore.failCheck(connection, this.workerId, compactError(err), now);
      this.options.logger?.warn(`Feishu auth check failed user=${user.id} profile=${connection.profileId}: ${compactError(err)}`);
    } finally {
      if (this.currentAbort === controller) this.currentAbort = undefined;
    }
  }
}

function deriveWorkspaceMountSubPath(agentCwd: string, userCwd: string): string | undefined {
  const mountRoot = resolve(agentCwd, '..');
  const rel = relative(mountRoot, resolve(userCwd));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function compactError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:app[_-]?secret|access[_-]?token|refresh[_-]?token|device[_-]?code|authorization)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000) || 'unknown_error';
}
