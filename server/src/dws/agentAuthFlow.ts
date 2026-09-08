import { mkdir } from 'node:fs/promises';

import type { DwsAuthSessionRecord, DwsAuthSessionStore } from './authStore.js';
import {
  resolveDwsPrincipalCwd,
  type DwsDeviceLoginRunnerLike,
  type DwsWorkspacePrincipal,
} from './authFlow.js';
import { readDwsProfiles } from './keepalive.js';
import type {
  AgentDwsAccountRecord,
  AgentDwsAccountStore,
  AgentDwsAuthorizedProfile,
} from '../data/agentDwsAccounts/index.js';

export interface AgentDwsAuthFlowServiceLike {
  start(account: AgentDwsAccountRecord): Promise<DwsAuthSessionRecord>;
  getLatest(tenantId: string, accountId: string): Promise<DwsAuthSessionRecord | null>;
  cancel(tenantId: string, accountId: string): Promise<void>;
  stop(): void | Promise<void>;
}

export class AgentDwsAuthFlowService implements AgentDwsAuthFlowServiceLike {
  private readonly active = new Map<string, AbortController>();
  private readonly tasks = new Map<string, Promise<void>>();
  private cleanupRetryTimer?: ReturnType<typeof setTimeout>;
  private cleanupRecoveryTask?: Promise<void>;
  private stopped = false;

  constructor(private readonly options: {
    agentCwd: string;
    authSessionStore: DwsAuthSessionStore;
    accountStore: AgentDwsAccountStore;
    runner: DwsDeviceLoginRunnerLike;
    stopPreviousIdentity?: (previous: AgentDwsAccountRecord) => Promise<void>;
    invalidatePreviousIdentityContext?: (previous: AgentDwsAccountRecord) => Promise<void>;
    onConnected?: (account: AgentDwsAccountRecord) => Promise<void>;
    logger?: { info(message: string): void; warn(message: string): void };
  }) {}

  async start(account: AgentDwsAccountRecord): Promise<DwsAuthSessionRecord> {
    if (this.stopped) throw new Error('Agent DWS 授权服务正在停止');
    const identity = identityFor(account);
    const result = await this.options.authSessionStore.createOrReuse(identity);
    if (result.created) {
      const controller = new AbortController();
      const key = accountKey(account.tenantId, account.accountId);
      this.active.set(key, controller);
      const task = this.run(result.record, account, principalFor(account), controller).finally(() => {
        if (this.active.get(key) === controller) this.active.delete(key);
        if (this.tasks.get(key) === task) this.tasks.delete(key);
      });
      this.tasks.set(key, task);
      void task;
    }
    return result.record;
  }

  async getLatest(tenantId: string, accountId: string): Promise<DwsAuthSessionRecord | null> {
    return this.options.authSessionStore.getLatestForUser(tenantId, accountId);
  }

  async cancel(tenantId: string, accountId: string): Promise<void> {
    const key = accountKey(tenantId, accountId);
    this.active.get(key)?.abort();
    await this.tasks.get(key)?.catch(() => undefined);
    this.active.delete(key);
    this.tasks.delete(key);
    const latest = await this.options.authSessionStore.getLatestForUser(tenantId, accountId);
    if (latest && (latest.status === 'starting' || latest.status === 'awaiting_user')) {
      await this.options.authSessionStore.markFailed(
        latest.sessionId,
        { tenantId, userId: accountId, username: latest.username },
        'authorization_cancelled',
        '授权已取消',
      );
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.cleanupRetryTimer) clearTimeout(this.cleanupRetryTimer);
    this.cleanupRetryTimer = undefined;
    const tasks = [...this.tasks.values()];
    for (const controller of this.active.values()) controller.abort();
    await Promise.all(tasks.map(task => task.catch(() => undefined)));
    this.active.clear();
    this.tasks.clear();
    await this.cleanupRecoveryTask?.catch(() => undefined);
  }

  async recoverPendingIdentityCleanup(): Promise<void> {
    const accounts = await this.options.accountStore.listRunnable();
    const errors: unknown[] = [];
    for (const account of accounts) {
      if (!account.identityCleanupPending) continue;
      try {
        await this.recoverIdentityCleanup(account);
      } catch (error) {
        errors.push(error);
        this.options.logger?.warn(
          `Agent DWS identity cleanup failed account=${account.accountId}: ${compactError(error)}`,
        );
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Agent DWS identity cleanup incomplete');
  }

  startIdentityCleanupRecovery(retryMs = 30_000): void {
    if (this.stopped || this.cleanupRetryTimer || this.cleanupRecoveryTask) return;
    const schedule = () => {
      if (this.stopped) return;
      this.cleanupRetryTimer = setTimeout(() => {
        this.cleanupRetryTimer = undefined;
        this.cleanupRecoveryTask = this.recoverPendingIdentityCleanup()
          .catch(() => undefined)
          .finally(() => {
            this.cleanupRecoveryTask = undefined;
            schedule();
          });
      }, Math.max(100, retryMs));
    };
    schedule();
  }

  private async recoverIdentityCleanup(
    account: AgentDwsAccountRecord,
    restoreConnectedIdentity = true,
  ): Promise<void> {
    if (!account.identityCleanupPending) return;
    if (!account.identityUpdatedAt) {
      throw new Error('AGENT_DWS_IDENTITY_CLEANUP_EPOCH_MISSING');
    }
    if (!this.options.accountStore.markIdentityCleanupStep) {
      throw new Error('AGENT_DWS_IDENTITY_CLEANUP_STORE_UNAVAILABLE');
    }
    let current = account;
    const pending = account.identityCleanupPending;
    const previous = { ...account, ...pending.previous };
    if (!pending.streamStopped) {
      if (!this.options.stopPreviousIdentity) {
        throw new Error('AGENT_DWS_IDENTITY_CLEANUP_STOP_UNAVAILABLE');
      }
      await this.options.stopPreviousIdentity(previous);
      current = await this.options.accountStore.markIdentityCleanupStep(
        account.tenantId, account.accountId, account.identityUpdatedAt, 'stream_stopped',
      );
    }
    if (current.identityCleanupPending && !current.identityCleanupPending.contextInvalidated) {
      if (!this.options.invalidatePreviousIdentityContext) {
        throw new Error('AGENT_DWS_IDENTITY_CLEANUP_CONTEXT_UNAVAILABLE');
      }
      if (restoreConnectedIdentity && !this.options.onConnected) {
        throw new Error('AGENT_DWS_IDENTITY_CLEANUP_CONNECT_UNAVAILABLE');
      }
      await this.options.invalidatePreviousIdentityContext(previous);
      if (restoreConnectedIdentity) await this.options.onConnected?.(current);
      await this.options.accountStore.markIdentityCleanupStep(
        account.tenantId, account.accountId, account.identityUpdatedAt, 'context_invalidated',
      );
    }
  }

  private async run(
    session: DwsAuthSessionRecord,
    account: AgentDwsAccountRecord,
    principal: DwsWorkspacePrincipal,
    controller: AbortController,
  ): Promise<void> {
    const identity = identityFor(account);
    try {
      const principalCwd = resolveDwsPrincipalCwd(this.options.agentCwd, principal);
      await mkdir(principalCwd, { recursive: true, mode: 0o700 });
      const profilesBefore = await readDwsProfiles(principalCwd) ?? [];
      await this.options.runner.login(principal, async authorization => {
        await this.options.authSessionStore.markAwaitingUser(
          session.sessionId,
          identity,
          authorization.userCode,
          authorization.authorizationUrl,
        );
      }, controller.signal);
      if (controller.signal.aborted) throw new Error('Agent DWS 授权已取消');

      const profiles = await readDwsProfiles(principalCwd);
      const profile = resolveAuthorizedProfile(account, profiles ?? [], profilesBefore);
      const identityChanged = Boolean(account.profileId) && (
        account.profileId !== profile.profileId
        || account.corpId !== profile.corpId
        || account.dingtalkUserId !== profile.dingtalkUserId
      );
      if (identityChanged && (
        account.authorizationIntent?.mode !== 'replace_identity'
        || account.authorizationIntent.expectedProfileId !== account.profileId
        || account.authorizationIntent.expectedIdentityUpdatedAt !== account.identityUpdatedAt
      )) {
        throw new Error('AGENT_DWS_ACCOUNT_IDENTITY_CHANGE_NOT_CONFIRMED');
      }
      const updated = await this.options.accountStore.markAuthorized(
        account.tenantId,
        account.accountId,
        account.revision,
        profile,
        'system:agent-dws-auth',
      );
      await this.options.authSessionStore.markConnected(session.sessionId, identity);
      let identityCleanupError: unknown;
      if (identityChanged) {
        try {
          await this.recoverIdentityCleanup(updated, false);
        } catch (error) {
          identityCleanupError = error;
        }
      }
      // CAS 已提交后必须始终恢复新身份；后处理失败不能再把新身份标成授权失败。
      await this.options.onConnected?.(updated);
      if (identityCleanupError) {
        this.options.logger?.warn(
          `Agent DWS old identity cleanup incomplete account=${account.accountId}: ${compactError(identityCleanupError)}`,
        );
      }
      this.options.logger?.info(`Agent DWS authorization connected account=${account.accountId} profile=${profile.profileId}`);
    } catch (error) {
      const message = compactError(error);
      const expired = /expired|授权码.*过期|timed out|超时/i.test(message);
      await this.options.authSessionStore.markFailed(
        session.sessionId,
        identity,
        expired ? 'authorization_expired' : 'authorization_failed',
        expired ? '授权码已过期，请重新连接' : '钉钉授权未完成，请重试',
      ).catch(() => undefined);
      await this.options.accountStore.markAuthorizationFailed(
        account.tenantId,
        account.accountId,
        account.revision,
        expired ? 'authorization_expired' : message,
        'system:agent-dws-auth',
      ).catch(() => undefined);
      if (!controller.signal.aborted) {
        this.options.logger?.warn(`Agent DWS authorization failed account=${account.accountId}: ${message}`);
      }
    }
  }
}

export function principalFor(account: AgentDwsAccountRecord): DwsWorkspacePrincipal {
  return {
    id: account.accountId,
    username: account.displayName,
    tenantId: account.tenantId,
    role: 'user',
    principalType: 'agent',
    agentId: account.agentId,
  };
}

interface DwsAuthorizedProfileCandidate {
  profileId: string;
  corpId: string;
  isCurrent?: boolean;
  corpName?: string;
  dingtalkUserId?: string;
  dingtalkUserName?: string;
  expiresAt?: string;
  refreshExpiresAt?: string;
  lastLoginAt?: string;
  lastUsedAt?: string;
  updatedAt?: string;
}

function resolveAuthorizedProfile(
  account: AgentDwsAccountRecord,
  profiles: DwsAuthorizedProfileCandidate[],
  profilesBefore: DwsAuthorizedProfileCandidate[],
): AgentDwsAuthorizedProfile {
  if (profiles.length === 0) throw new Error('钉钉授权成功但未生成组织 profile');
  const current = profiles.filter(profile => profile.isCurrent);
  if (current.length > 1) throw new Error('profiles.json 包含多个 current profile，无法确定授权账号');

  const candidates = account.corpId
    ? profiles.filter(profile => profile.corpId === account.corpId)
    : profiles;
  if (candidates.length === 0) throw new Error('授权账号不属于配置的钉钉组织');
  const baselineBySelector = new Map(
    profilesBefore.filter(hasExactProfileCandidate).map(profile => [profile.profileId, profile]),
  );
  // current is only a pointer; it cannot disambiguate concurrent fresh authorization evidence.
  const evidenceCandidates = candidates.filter(profile => {
    if (!hasExactProfileCandidate(profile)) return false;
    const previous = baselineBySelector.get(profile.profileId);
    return !previous || hasFreshAuthorizationEvidence(previous, profile);
  });

  const currentProfile = current[0];
  if (currentProfile && account.corpId && currentProfile.corpId !== account.corpId) {
    throw new Error('当前授权账号不属于配置的钉钉组织');
  }
  if (evidenceCandidates.length > 1) {
    throw new Error('授权生成多个新鲜钉钉账号，已拒绝自动选择');
  }
  const selected = evidenceCandidates[0];
  if (!selected) {
    if (currentProfile) {
      throw new Error('授权后的 current profile 缺少新鲜授权证据，已拒绝自动选择');
    }
    throw new Error('授权后没有唯一 current profile 或新鲜账号证据，已拒绝自动选择旧账号');
  }
  if (currentProfile && currentProfile.profileId !== selected.profileId) {
    throw new Error('授权后的 current profile 与新增账号证据冲突，已拒绝自动选择');
  }

  const dingtalkUserId = selected.dingtalkUserId?.trim();
  const exactProfileId = dingtalkUserId ? `${selected.corpId}:${dingtalkUserId}` : undefined;
  if (!dingtalkUserId || selected.profileId !== exactProfileId) {
    throw new Error('授权 profile 缺少可验证的钉钉账号身份，已拒绝组织级 selector');
  }
  return {
    profileId: selected.profileId,
    corpId: selected.corpId,
    ...(selected.corpName ? { corpName: selected.corpName } : {}),
    dingtalkUserId,
    ...(selected.dingtalkUserName ? { dingtalkUserName: selected.dingtalkUserName } : {}),
  };
}

function hasExactProfileCandidate(profile: DwsAuthorizedProfileCandidate): boolean {
  const userId = profile.dingtalkUserId?.trim();
  return Boolean(userId && profile.profileId === `${profile.corpId}:${userId}`);
}

function hasFreshAuthorizationEvidence(
  previous: DwsAuthorizedProfileCandidate,
  current: DwsAuthorizedProfileCandidate,
): boolean {
  const fields = [
    'expiresAt',
    'refreshExpiresAt',
    'lastLoginAt',
    'lastUsedAt',
    'updatedAt',
  ] as const;
  return fields.some(field => Boolean(current[field]) && current[field] !== previous[field]);
}

function identityFor(
  account: AgentDwsAccountRecord,
): { tenantId: string; userId: string; username: string } {
  return { tenantId: account.tenantId, userId: account.accountId, username: account.displayName };
}

function accountKey(tenantId: string, accountId: string): string {
  return `${tenantId}:${accountId}`;
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/https:\/\/login\.dingtalk\.com\/oauth2\/device\/verify\.htm\?user_code=[A-Z0-9-]+/gi, '[DWS_AUTH_URL_REDACTED]')
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/gi, '[DWS_USER_CODE_REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'unknown_error';
}
