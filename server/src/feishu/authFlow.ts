import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { UserInfo } from '../data/users/types.js';
import { HttpTransport } from '../runtime/httpTransport.js';
import { deriveStableWorkspaceId } from '../runtime/workspaceIdentity.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import type {
  FeishuAuthSessionIdentity,
  FeishuAuthSessionRecord,
  FeishuAuthSessionStore,
} from './authStore.js';
import type { FeishuConnectionStore, FeishuLoginMetadata } from './store.js';

const FEISHU_PROFILE_ID = 'kaiyan-agent';
const FEISHU_AUTH_TIMEOUT_MS = 11 * 60 * 1_000;

export interface FeishuDeviceAuthorization {
  authorizationUrl: string;
}

export interface FeishuDeviceLoginRunnerLike {
  login(
    user: UserInfo,
    onAuthorization: (authorization: FeishuDeviceAuthorization) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<FeishuLoginMetadata>;
}

export interface FeishuDeviceLoginRunnerOptions {
  agentCwd: string;
  appId: string;
  appSecret: string;
  profileId?: string;
  resolveServerRemote: (user: UserInfo) => Promise<{
    baseUrl: string;
    authToken: string;
    invokeTimeoutMs?: number;
  }>;
  fetchImpl?: typeof fetch;
}

export class FeishuDeviceLoginRunner implements FeishuDeviceLoginRunnerLike {
  private readonly profileId: string;

  constructor(private readonly options: FeishuDeviceLoginRunnerOptions) {
    this.profileId = options.profileId ?? FEISHU_PROFILE_ID;
  }

  async login(
    user: UserInfo,
    onAuthorization: (authorization: FeishuDeviceAuthorization) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<FeishuLoginMetadata> {
    const transport = await this.createTransport(user);
    const context = this.createContext(user, signal, 'auth');

    await invokeFeishuCli(transport, {
      operation: 'init',
      profile: this.profileId,
      appId: this.options.appId,
      appSecret: this.options.appSecret,
    }, context);

    const startOutput = await invokeFeishuCli(transport, {
      operation: 'start_auth',
      profile: this.profileId,
    }, context);
    const start = parseFeishuJson(startOutput);
    const authorizationUrl = validateFeishuAuthorizationUrl(stringField(start.verification_url));
    const deviceCode = boundedDeviceCode(start.device_code);
    await onAuthorization({ authorizationUrl });

    const response = await transport.invoke({
      toolName: '__FeishuCli',
      input: { operation: 'complete_auth', profile: this.profileId, deviceCode },
      context,
    });
    const completionOutput = response.status === 'success' ? response.content : response.error;
    const completion = parseFeishuJson(completionOutput);
    if (stringField(completion.event) !== 'authorization_complete') {
      throw new Error(response.status === 'error' ? response.error : '飞书授权未返回完成状态');
    }
    const userOpenId = boundedString(completion.user_open_id, 512);
    if (!userOpenId) throw new Error('飞书授权成功但未返回用户标识');
    const scope = stringField(completion.scope)
      ?? (Array.isArray(completion.granted)
        ? completion.granted.filter((item): item is string => typeof item === 'string').join(' ')
        : undefined);
    return {
      profileId: this.profileId,
      appId: this.options.appId,
      userOpenId,
      ...(boundedString(completion.user_name, 512) ? { userName: boundedString(completion.user_name, 512) } : {}),
      ...(scope ? { scope } : {}),
    };
  }

  private async createTransport(user: UserInfo): Promise<HttpTransport> {
    const serverRemote = await this.options.resolveServerRemote(user);
    return new HttpTransport({
      baseUrl: serverRemote.baseUrl,
      authToken: serverRemote.authToken,
      invokeTimeoutMs: Math.max(serverRemote.invokeTimeoutMs ?? 0, FEISHU_AUTH_TIMEOUT_MS + 10_000),
      fetchImpl: this.options.fetchImpl,
    });
  }

  private createContext(user: UserInfo, signal: AbortSignal | undefined, purpose: string) {
    const userCwd = resolveUserCwd(this.options.agentCwd, user);
    const mountSubPath = deriveWorkspaceMountSubPath(this.options.agentCwd, userCwd);
    if (!mountSubPath) throw new Error('无法解析飞书用户工作区挂载路径');
    const workspaceId = deriveStableWorkspaceId(user, `feishu-${user.id}`);
    return {
      invocationId: `feishu-${purpose}-${randomUUID()}`,
      signal,
      workspace: {
        id: workspaceId,
        root: userCwd,
        userId: user.id,
        username: user.username,
        tenantId: user.tenantId,
        sessionId: `feishu-${purpose}-${user.id}`,
        sandboxScopeId: `${workspaceId}__${mountSubPath.replace(/[^A-Za-z0-9_-]+/g, '_')}`,
        mountSubPath,
        executionTarget: 'server-remote' as const,
      },
    };
  }
}

async function invokeFeishuCli(
  transport: HttpTransport,
  input: Record<string, unknown>,
  context: ReturnType<FeishuDeviceLoginRunner['createContext']>,
): Promise<string> {
  const response = await transport.invoke({ toolName: '__FeishuCli', input, context });
  if (response.status === 'error') throw new Error(redactFeishuError(response.error));
  return response.content;
}

export interface FeishuAuthFlowServiceLike {
  start(user: UserInfo): Promise<FeishuAuthSessionRecord>;
  getLatest(tenantId: string, userId: string): Promise<FeishuAuthSessionRecord | null>;
}

export interface FeishuAuthFlowServiceOptions {
  authSessionStore: FeishuAuthSessionStore;
  connectionStore: FeishuConnectionStore;
  runner: FeishuDeviceLoginRunnerLike;
  onConnected?: (user: UserInfo) => Promise<void>;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export class FeishuAuthFlowService implements FeishuAuthFlowServiceLike {
  private readonly active = new Map<string, AbortController>();
  private stopped = false;

  constructor(private readonly options: FeishuAuthFlowServiceOptions) {}

  async start(user: UserInfo): Promise<FeishuAuthSessionRecord> {
    if (this.stopped) throw new Error('飞书授权服务正在停止');
    const identity = identityFor(user);
    const result = await this.options.authSessionStore.createOrReuse(identity);
    if (result.created) {
      const controller = new AbortController();
      this.active.set(result.record.sessionId, controller);
      void this.run(result.record, user, identity, controller).finally(() => {
        if (this.active.get(result.record.sessionId) === controller) this.active.delete(result.record.sessionId);
      });
    }
    return result.record;
  }

  async getLatest(tenantId: string, userId: string): Promise<FeishuAuthSessionRecord | null> {
    return await this.options.authSessionStore.getLatestForUser(tenantId, userId);
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  private async run(
    session: FeishuAuthSessionRecord,
    user: UserInfo,
    identity: FeishuAuthSessionIdentity,
    controller: AbortController,
  ): Promise<void> {
    try {
      const login = await this.options.runner.login(user, async ({ authorizationUrl }) => {
        await this.options.authSessionStore.markAwaitingUser(session.sessionId, identity, authorizationUrl);
      }, controller.signal);
      await this.options.connectionStore.upsertLogin(identity, login);
      await this.options.authSessionStore.markConnected(session.sessionId, identity);
      await this.options.onConnected?.(user).catch((err) => {
        this.options.logger?.warn(`Feishu post-login verification deferred user=${user.id}: ${redactFeishuError(err)}`);
      });
      this.options.logger?.info(`Feishu authorization connected user=${user.id} profile=${login.profileId}`);
    } catch (err) {
      const message = redactFeishuError(err);
      const expired = /expired|authorization.*过期|授权.*过期|timed out|超时/i.test(message);
      await this.options.authSessionStore.markFailed(
        session.sessionId,
        identity,
        expired ? 'authorization_expired' : 'authorization_failed',
        expired ? '授权链接已过期，请重新连接' : '飞书授权未完成，请重试',
      ).catch(() => undefined);
      if (!controller.signal.aborted) {
        this.options.logger?.warn(`Feishu authorization failed user=${user.id}: ${message}`);
      }
    }
  }
}

export function parseFeishuJson(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // 继续尝试完整输出中的 JSON 对象。
    }
  }
  const starts = [...trimmed.matchAll(/\{/g)].map((match) => match.index);
  const ends = [...trimmed.matchAll(/\}/g)].map((match) => match.index).reverse();
  for (const start of starts) {
    for (const end of ends) {
      if (end <= start) continue;
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // Shell/CLI 错误可能在 JSON 前后附带文本或第二个 JSON；继续缩小窗口。
      }
    }
  }
  throw new Error('飞书 CLI 未返回有效 JSON');
}

export function validateFeishuAuthorizationUrl(value: string | undefined): string {
  if (!value || value.length > 4_096) throw new Error('飞书 CLI 未返回官方授权页面');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('飞书 CLI 返回的授权页面格式无效');
  }
  if (url.protocol !== 'https:' || !['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname)) {
    throw new Error('飞书 CLI 返回了非官方授权页面');
  }
  return url.toString();
}

function boundedDeviceCode(value: unknown): string {
  const code = boundedString(value, 1_024);
  if (!code || !/^[A-Za-z0-9._~-]+$/.test(code)) throw new Error('飞书 CLI 未返回有效 device_code');
  return code;
}

function identityFor(user: UserInfo): FeishuAuthSessionIdentity {
  return { tenantId: user.tenantId, userId: user.id, username: user.username };
}

function deriveWorkspaceMountSubPath(agentCwd: string, userCwd: string): string | undefined {
  const mountRoot = resolve(agentCwd, '..');
  const rel = relative(mountRoot, resolve(userCwd));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function redactFeishuError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:app[_-]?secret|access[_-]?token|refresh[_-]?token|device[_-]?code|authorization)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/https:\/\/[^\s"']*feishu\.cn\/[^\s"']+/gi, '[FEISHU_AUTH_URL_REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000) || 'unknown_error';
}
