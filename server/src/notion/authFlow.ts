import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { UserInfo } from '../data/users/types.js';
import type {
  DwsAuthSessionIdentity,
  DwsAuthSessionRecord,
  DwsAuthSessionStore,
} from '../dws/authStore.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { deriveStableWorkspaceId } from '../runtime/workspaceIdentity.js';
import { HttpTransport } from '../runtime/httpTransport.js';
import type { ToolInvocationResponse } from '../runtime/handProtocol.js';

const NOTION_LOGIN_TIMEOUT_MS = 12 * 60 * 1_000;
const MAX_OUTPUT_CHARS = 16_000;
const NOTION_AUTH_ENV = 'export NOTION_KEYRING=0 XDG_CONFIG_HOME="$PWD/.notion-auth"; mkdir -p "$XDG_CONFIG_HOME"; ';

export interface NotionDeviceAuthorization {
  authorizationUrl: string;
  userCode: string;
}

export interface NotionDeviceLoginRunnerLike {
  login(
    user: UserInfo,
    onAuthorization: (authorization: NotionDeviceAuthorization) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface NotionDeviceLoginRunnerOptions {
  agentCwd: string;
  serverRemote?: {
    baseUrl: string;
    authToken: string;
    invokeTimeoutMs?: number;
  };
  resolveServerRemote?: (user: UserInfo) => Promise<{
    baseUrl: string;
    authToken: string;
    invokeTimeoutMs?: number;
  } | undefined>;
  fetchImpl?: typeof fetch;
}

export class NotionDeviceLoginRunner implements NotionDeviceLoginRunnerLike {
  constructor(private readonly options: NotionDeviceLoginRunnerOptions) {}

  async login(
    user: UserInfo,
    onAuthorization: (authorization: NotionDeviceAuthorization) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<string> {
    const serverRemote = await resolveServerRemote(this.options, user);
    const transport = new HttpTransport({
      baseUrl: serverRemote.baseUrl,
      authToken: serverRemote.authToken,
      invokeTimeoutMs: Math.max(serverRemote.invokeTimeoutMs ?? 0, NOTION_LOGIN_TIMEOUT_MS + 10_000),
      fetchImpl: this.options.fetchImpl,
    });
    const context = createExecutionContext(this.options.agentCwd, user, signal);

    try {
      const startOutput = await invokeShell(
        transport,
        context,
        `${NOTION_AUTH_ENV}ntn login --no-browser`,
        60_000,
      );
      const authorization = parseNotionDeviceAuthorization(startOutput);
      if (!authorization) throw new Error('Notion CLI 未返回官方授权页面');
      await onAuthorization(authorization);

      await invokeShell(
        transport,
        context,
        `${NOTION_AUTH_ENV}ntn login poll`,
        NOTION_LOGIN_TIMEOUT_MS,
      );
      const token = (await invokeShell(
        transport,
        context,
        `${NOTION_AUTH_ENV}ntn auth token`,
        60_000,
      )).trim();
      if (!token || token.length < 8 || /\s/.test(token)) {
        throw new Error('Notion CLI 已登录，但未返回有效 API token');
      }
      return token;
    } finally {
      await invokeShell(
        transport,
        context,
        `${NOTION_AUTH_ENV}ntn logout >/dev/null 2>&1 || true; rm -rf "$PWD/.notion-auth"`,
        30_000,
      ).catch(() => undefined);
    }
  }
}

export interface NotionAuthFlowServiceLike {
  start(user: UserInfo): Promise<DwsAuthSessionRecord>;
  getLatest(tenantId: string, userId: string): Promise<DwsAuthSessionRecord | null>;
  cancelUser?(tenantId: string, userId: string): Promise<void>;
  stop(): void;
}

export interface NotionAuthFlowServiceOptions {
  authSessionStore: DwsAuthSessionStore;
  runner: NotionDeviceLoginRunnerLike;
  onCredential: (user: UserInfo, token: string) => Promise<void>;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export class NotionAuthFlowService implements NotionAuthFlowServiceLike {
  private readonly active = new Map<string, AbortController>();
  private readonly activeUsers = new Map<string, AbortController>();
  private readonly activeTasks = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private readonly options: NotionAuthFlowServiceOptions) {}

  async start(user: UserInfo): Promise<DwsAuthSessionRecord> {
    if (this.stopped) throw new Error('Notion 授权服务正在停止');
    const identity = identityFor(user);
    const result = await this.options.authSessionStore.createOrReuse(identity);
    if (result.created) {
      const controller = new AbortController();
      const userKey = `${identity.tenantId}:${identity.userId}`;
      this.active.set(result.record.sessionId, controller);
      this.activeUsers.set(userKey, controller);
      const task = this.run(result.record, user, identity, controller).finally(() => {
        if (this.active.get(result.record.sessionId) === controller) this.active.delete(result.record.sessionId);
        if (this.activeUsers.get(userKey) === controller) this.activeUsers.delete(userKey);
        if (this.activeTasks.get(userKey) === task) this.activeTasks.delete(userKey);
      });
      this.activeTasks.set(userKey, task);
      void task;
    }
    return result.record;
  }

  async getLatest(tenantId: string, userId: string): Promise<DwsAuthSessionRecord | null> {
    return await this.options.authSessionStore.getLatestForUser(tenantId, userId);
  }

  async cancelUser(tenantId: string, userId: string): Promise<void> {
    const key = `${tenantId}:${userId}`;
    this.activeUsers.get(key)?.abort();
    await this.activeTasks.get(key)?.catch(() => undefined);
    this.activeUsers.delete(key);
    this.activeTasks.delete(key);
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.activeUsers.clear();
    this.activeTasks.clear();
  }

  private async run(
    session: DwsAuthSessionRecord,
    user: UserInfo,
    identity: DwsAuthSessionIdentity,
    controller: AbortController,
  ): Promise<void> {
    try {
      const token = await this.options.runner.login(user, async (authorization) => {
        await this.options.authSessionStore.markAwaitingUser(
          session.sessionId,
          identity,
          authorization.userCode,
          authorization.authorizationUrl,
        );
      }, controller.signal);
      if (controller.signal.aborted) throw new Error('Notion 授权已取消');
      await this.options.onCredential(user, token);
      if (controller.signal.aborted) throw new Error('Notion 授权已取消');
      await this.options.authSessionStore.markConnected(session.sessionId, identity);
      this.options.logger?.info(`Notion authorization connected user=${user.id}`);
    } catch (err) {
      const message = redactNotionError(err);
      const expired = /expired|timed out|超时/i.test(message);
      await this.options.authSessionStore.markFailed(
        session.sessionId,
        identity,
        expired ? 'authorization_expired' : 'authorization_failed',
        expired ? '授权码已过期，请重新连接' : 'Notion 授权未完成，请重试',
      );
      this.options.logger?.warn(`Notion authorization failed user=${user.id}: ${message}`);
    }
  }
}

export function parseNotionDeviceAuthorization(output: string): NotionDeviceAuthorization | null {
  const cleaned = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
  const url = cleaned.match(/https:\/\/www\.notion\.so\/[^\s]+verificationCode=([A-Z0-9-]+)/i)?.[0];
  if (!url) return null;
  let decodedUrl = url;
  try {
    decodedUrl = decodeURIComponent(url);
  } catch {
    // 保留 CLI 原始 URL。
  }
  const userCode = decodedUrl.match(/[?&]verificationCode=([A-Z0-9-]+)/i)?.[1];
  if (!userCode) return null;
  return { authorizationUrl: decodedUrl, userCode };
}

function identityFor(user: UserInfo): DwsAuthSessionIdentity {
  return {
    tenantId: user.tenantId,
    userId: user.id,
    username: user.username,
  };
}

function createExecutionContext(agentCwd: string, user: UserInfo, signal?: AbortSignal) {
  const userCwd = resolveUserCwd(agentCwd, user);
  const mountSubPath = deriveWorkspaceMountSubPath(agentCwd, userCwd);
  if (!mountSubPath) throw new Error('无法解析 Notion 用户工作区挂载路径');
  const workspaceId = deriveStableWorkspaceId(user, `notion-${user.id}`);
  const sandboxScopeId = `${workspaceId}__${mountSubPath.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
  return {
    invocationId: `notion-auth-${randomUUID()}`,
    signal,
    workspace: {
      id: workspaceId,
      root: userCwd,
      userId: user.id,
      username: user.username,
      tenantId: user.tenantId,
      sessionId: `notion-auth-${user.id}`,
      sandboxScopeId,
      mountSubPath,
      executionTarget: 'server-remote' as const,
    },
  };
}

function deriveWorkspaceMountSubPath(agentCwd: string, userCwd: string): string | undefined {
  const root = resolve(agentCwd);
  const target = resolve(userCwd);
  const rel = relative(root, target);
  if (!rel || rel === '.') return undefined;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).filter(Boolean).join('/');
}

async function invokeShell(
  transport: HttpTransport,
  context: ReturnType<typeof createExecutionContext>,
  command: string,
  timeoutMs: number,
): Promise<string> {
  let output = '';
  let finalResponse: ToolInvocationResponse | undefined;
  for await (const chunk of transport.invokeStream({
    toolName: 'Shell',
    input: { command, timeoutMs },
    context,
  })) {
    if (chunk.type === 'output') output = `${output}${chunk.content}`.slice(-MAX_OUTPUT_CHARS);
    else if (chunk.type === 'completed') finalResponse = chunk.response;
  }
  if (!finalResponse) throw new Error('Notion CLI 任务结束但没有返回结果');
  if (finalResponse.status === 'error') throw new Error(redactNotionError(finalResponse.error));
  return output.trim() || finalResponse.content.trim();
}

async function resolveServerRemote(
  options: NotionDeviceLoginRunnerOptions,
  user: UserInfo,
): Promise<{ baseUrl: string; authToken: string; invokeTimeoutMs?: number }> {
  const resolved = options.resolveServerRemote
    ? await options.resolveServerRemote(user)
    : options.serverRemote;
  if (!resolved) throw new Error('当前用户没有可用的 Notion 执行环境');
  return resolved;
}

function redactNotionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return raw
    .replace(/(?:ntn|secret)_[A-Za-z0-9_-]{8,}/gi, '[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .slice(0, 500);
}
