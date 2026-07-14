import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { UserInfo } from '../data/users/types.js';
import { HttpTransport } from '../runtime/httpTransport.js';
import type { ToolInvocationResponse } from '../runtime/handProtocol.js';
import { deriveStableWorkspaceId } from '../runtime/workspaceIdentity.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import type {
  DwsAuthSessionIdentity,
  DwsAuthSessionRecord,
  DwsAuthSessionStore,
} from './authStore.js';
import { readDwsProfiles } from './keepalive.js';
import type { DwsConnectionStore } from './store.js';

const DWS_DEVICE_FLOW_TIMEOUT_MS = 15 * 60 * 1_000;
const DWS_AUTH_URL_BASE = 'https://login.dingtalk.com/oauth2/device/verify.htm';
const MAX_DEVICE_FLOW_OUTPUT_CHARS = 32_000;

export interface DwsDeviceAuthorization {
  userCode: string;
  authorizationUrl: string;
}

export interface DwsDeviceLoginRunnerLike {
  login(
    user: UserInfo,
    onAuthorization: (authorization: DwsDeviceAuthorization) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface DwsDeviceLoginRunnerOptions {
  agentCwd: string;
  serverRemote: {
    baseUrl: string;
    authToken: string;
    invokeTimeoutMs?: number;
  };
  fetchImpl?: typeof fetch;
}

export class DwsDeviceLoginRunner implements DwsDeviceLoginRunnerLike {
  private readonly transport: HttpTransport;

  constructor(private readonly options: DwsDeviceLoginRunnerOptions) {
    this.transport = new HttpTransport({
      baseUrl: options.serverRemote.baseUrl,
      authToken: options.serverRemote.authToken,
      invokeTimeoutMs: Math.max(options.serverRemote.invokeTimeoutMs ?? 0, DWS_DEVICE_FLOW_TIMEOUT_MS + 10_000),
      fetchImpl: options.fetchImpl,
    });
  }

  async login(
    user: UserInfo,
    onAuthorization: (authorization: DwsDeviceAuthorization) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const userCwd = resolveUserCwd(this.options.agentCwd, user);
    const mountSubPath = deriveWorkspaceMountSubPath(this.options.agentCwd, userCwd);
    if (!mountSubPath) throw new Error('无法解析 DWS 用户工作区挂载路径');
    const workspaceId = deriveStableWorkspaceId(user, `dws-${user.id}`);
    const sandboxScopeId = `${workspaceId}__${mountSubPath.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
    let output = '';
    let authorizationPublished = false;
    let finalResponse: ToolInvocationResponse | undefined;

    for await (const chunk of this.transport.invokeStream({
      toolName: 'Shell',
      input: {
        command: 'dws auth login --device --format json',
        // 内部平台调用，不经过面向模型的 Shell zod 上限；ACS runner 原生支持该超时。
        timeoutMs: DWS_DEVICE_FLOW_TIMEOUT_MS,
      },
      context: {
        invocationId: `dws-auth-${randomUUID()}`,
        signal,
        workspace: {
          id: workspaceId,
          root: userCwd,
          userId: user.id,
          username: user.username,
          tenantId: user.tenantId,
          sessionId: `dws-auth-${user.id}`,
          sandboxScopeId,
          mountSubPath,
          executionTarget: 'server-remote',
        },
      },
    })) {
      if (chunk.type === 'output') {
        output = `${output}${chunk.content}`.slice(-MAX_DEVICE_FLOW_OUTPUT_CHARS);
        if (!authorizationPublished) {
          const authorization = parseDwsDeviceAuthorization(output);
          if (authorization) {
            authorizationPublished = true;
            await onAuthorization(authorization);
          }
        }
      } else if (chunk.type === 'completed') {
        finalResponse = chunk.response;
      }
    }

    if (!finalResponse) throw new Error('DWS 授权任务结束但没有返回结果');
    if (finalResponse.status === 'error') throw new Error(redactDwsError(finalResponse.error));
    if (!authorizationPublished) {
      const authorization = parseDwsDeviceAuthorization(`${output}\n${finalResponse.content}`);
      if (!authorization) throw new Error('DWS 未返回钉钉官方授权页面');
      await onAuthorization(authorization);
    }
  }
}

export interface DwsAuthFlowServiceLike {
  start(user: UserInfo): Promise<DwsAuthSessionRecord>;
  getLatest(tenantId: string, userId: string): Promise<DwsAuthSessionRecord | null>;
}

export interface DwsAuthFlowServiceOptions {
  agentCwd: string;
  authSessionStore: DwsAuthSessionStore;
  connectionStore: DwsConnectionStore;
  runner: DwsDeviceLoginRunnerLike;
  onConnected?: () => Promise<void>;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export class DwsAuthFlowService implements DwsAuthFlowServiceLike {
  private readonly active = new Map<string, AbortController>();
  private stopped = false;

  constructor(private readonly options: DwsAuthFlowServiceOptions) {}

  async start(user: UserInfo): Promise<DwsAuthSessionRecord> {
    if (this.stopped) throw new Error('DWS 授权服务正在停止');
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

  async getLatest(tenantId: string, userId: string): Promise<DwsAuthSessionRecord | null> {
    return await this.options.authSessionStore.getLatestForUser(tenantId, userId);
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  private async run(
    session: DwsAuthSessionRecord,
    user: UserInfo,
    identity: DwsAuthSessionIdentity,
    controller: AbortController,
  ): Promise<void> {
    try {
      await this.options.runner.login(user, async (authorization) => {
        await this.options.authSessionStore.markAwaitingUser(
          session.sessionId,
          identity,
          authorization.userCode,
          authorization.authorizationUrl,
        );
      }, controller.signal);

      const profiles = await readDwsProfiles(resolveUserCwd(this.options.agentCwd, user));
      if (!profiles || profiles.length === 0) throw new Error('钉钉已返回授权成功，但未生成组织连接信息');
      await this.options.connectionStore.syncProfiles(identity, profiles);
      await this.options.authSessionStore.markConnected(session.sessionId, identity);
      await this.options.onConnected?.().catch((err) => {
        this.options.logger?.warn(`DWS post-login verification deferred user=${user.id}: ${redactDwsError(err)}`);
      });
      this.options.logger?.info(`DWS authorization connected user=${user.id} profiles=${profiles.length}`);
    } catch (err) {
      const message = redactDwsError(err);
      const expired = /expired|authorization code.*过期|授权码.*过期|timed out|超时/i.test(message);
      await this.options.authSessionStore.markFailed(
        session.sessionId,
        identity,
        expired ? 'authorization_expired' : 'authorization_failed',
        expired ? '授权码已过期，请重新连接' : '钉钉授权未完成，请重试',
      ).catch(() => undefined);
      if (!controller.signal.aborted) {
        this.options.logger?.warn(`DWS authorization failed user=${user.id}: ${message}`);
      }
    }
  }
}

export function parseDwsDeviceAuthorization(output: string): DwsDeviceAuthorization | null {
  const urlMatch = output.match(/https:\/\/login\.dingtalk\.com\/oauth2\/device\/verify\.htm\?user_code=([A-Z0-9]{4}-[A-Z0-9]{4})/i);
  const codeMatch = urlMatch?.[1];
  if (!codeMatch) return null;
  const userCode = codeMatch.toUpperCase();
  return {
    userCode,
    authorizationUrl: `${DWS_AUTH_URL_BASE}?user_code=${encodeURIComponent(userCode)}`,
  };
}

function identityFor(user: UserInfo): DwsAuthSessionIdentity {
  return { tenantId: user.tenantId, userId: user.id, username: user.username };
}

function deriveWorkspaceMountSubPath(agentCwd: string, userCwd: string): string | undefined {
  const mountRoot = resolve(agentCwd, '..');
  const rel = relative(mountRoot, resolve(userCwd));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

function redactDwsError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/https:\/\/login\.dingtalk\.com\/oauth2\/device\/verify\.htm\?user_code=[A-Z0-9-]+/gi, '[DWS_AUTH_URL_REDACTED]')
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/gi, '[DWS_USER_CODE_REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000) || 'unknown_error';
}
