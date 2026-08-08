import { createHash } from 'node:crypto';

import type { SecretVault, VaultCaller, VaultOperation } from '../../security/secretVault.js';
import {
  CodexSubscriptionTelemetry,
  type CodexSubscriptionRuntimeStatus,
  type CodexWireRequestSample,
} from './codexSubscriptionTelemetry.js';

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTH_BASE_URL = 'https://auth.openai.com';
export const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
export const CODEX_DEVICE_VERIFICATION_URI = `${CODEX_AUTH_BASE_URL}/codex/device`;

const REFRESH_EARLY_MS = 5 * 60 * 1000;
const CODEX_SECRET_KIND = 'codex_subscription_oauth';
function systemVaultCaller(operation: VaultOperation): VaultCaller {
  return {
    actor: 'system',
    userId: '__system__',
    scopes: [`secret:${CODEX_SECRET_KIND}:${operation}`],
  };
}

export interface CodexSubscriptionRuntimeConfig {
  enabled?: boolean;
  credentialRef?: string;
  endpoint?: string;
  originator?: string;
  /** 连接内 stateful 接力；关闭时保持 HTTP/SSE 全量历史。 */
  websocketEnabled?: boolean;
}

export interface CodexOAuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: string;
}

export interface CodexTokenBundle extends CodexOAuthTokens {
  accountId: string;
  generation: number;
}

export interface CodexCredentialStatus {
  configured: boolean;
  connected: boolean;
  accountBindingHash?: string;
  accountIdHint?: string;
  email?: string;
  expiresAt?: string;
  accessTokenExpired?: boolean;
  generation?: number;
  error?: string;
}

export interface CodexCredentialLock {
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

interface PgLockClient {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  release(): void;
}

export interface PgLockPool {
  connect(): Promise<PgLockClient>;
}

export class PgCodexCredentialLock implements CodexCredentialLock {
  constructor(private readonly pool: PgLockPool) {}

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
      client.release();
    }
  }
}

export class LocalCodexCredentialLock implements CodexCredentialLock {
  async runExclusive<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export class CodexCredentialManager {
  private readonly refreshInFlight = new Map<string, Promise<CodexTokenBundle>>();
  private readonly telemetry = new CodexSubscriptionTelemetry();

  constructor(private readonly options: {
    vault: SecretVault;
    getConfig: () => CodexSubscriptionRuntimeConfig | undefined;
    lock?: CodexCredentialLock;
    fetchImpl?: typeof fetch;
  }) {}

  getConfiguration(): Required<Pick<CodexSubscriptionRuntimeConfig, 'enabled' | 'endpoint' | 'originator' | 'websocketEnabled'>>
    & Pick<CodexSubscriptionRuntimeConfig, 'credentialRef'> {
    const raw = this.options.getConfig() ?? {};
    return {
      enabled: raw.enabled === true,
      endpoint: validateCodexEndpoint(raw.endpoint ?? CODEX_RESPONSES_ENDPOINT),
      // ChatGPT private Codex endpoint currently accepts first-party Codex originators.
      // Keep the current CLI/TUI identity as the safe wire default; the app still owns the harness.
      originator: validateOriginator(raw.originator ?? 'codex-tui'),
      websocketEnabled: raw.websocketEnabled === true,
      ...(raw.credentialRef ? { credentialRef: raw.credentialRef } : {}),
    };
  }

  async getCredentials(
    forceRefresh = false,
    staleGeneration?: number,
  ): Promise<CodexTokenBundle> {
    const config = this.getConfiguration();
    if (!config.enabled) throw new Error('Codex subscription transport 未启用');
    if (!config.credentialRef) throw new Error('Codex subscription 尚未完成账号授权');
    const credentialRef = config.credentialRef;

    const observed = await this.readBundle(credentialRef);
    if (
      forceRefresh
      && staleGeneration !== undefined
      && observed.generation > staleGeneration
      && !isExpiring(observed)
    ) {
      return observed;
    }
    if (!forceRefresh && !isExpiring(observed)) return observed;

    const existing = this.refreshInFlight.get(credentialRef);
    if (existing) return existing;

    const promise = this.refreshUnderLock(
      credentialRef,
      observed,
      forceRefresh,
      staleGeneration,
    )
      .finally(() => {
        if (this.refreshInFlight.get(credentialRef) === promise) {
          this.refreshInFlight.delete(credentialRef);
        }
      });
    this.refreshInFlight.set(credentialRef, promise);
    return promise;
  }

  async persistLogin(tokens: CodexOAuthTokens, existingRef?: string): Promise<{
    credentialRef: string;
    bundle: CodexTokenBundle;
  }> {
    const accountId = extractCodexAccountId(tokens.accessToken, tokens.idToken);
    const bundle: CodexTokenBundle = {
      ...tokens,
      accountId,
      generation: 1,
    };
    const serialized = JSON.stringify(bundle);
    if (existingRef) {
      const previous = await this.readBundle(existingRef).catch(() => undefined);
      await this.options.vault.rotateSecret(existingRef, serialized, systemVaultCaller('rotate'));
      if (previous?.refreshToken && previous.refreshToken !== bundle.refreshToken) {
        await revokeCodexRefreshToken(
          previous.refreshToken,
          this.options.fetchImpl ?? fetch,
        ).catch(() => undefined);
      }
      return { credentialRef: existingRef, bundle };
    }
    const ref = await this.options.vault.putSecret(
      'global',
      CODEX_SECRET_KIND,
      serialized,
      systemVaultCaller('write'),
      { accountBindingHash: hashAccountBinding(accountId) },
    );
    return { credentialRef: ref.id, bundle };
  }

  async revoke(credentialRef: string): Promise<{ remoteWarning?: string }> {
    let remoteWarning: string | undefined;
    try {
      const bundle = await this.readBundle(credentialRef);
      await revokeCodexRefreshToken(
        bundle.refreshToken,
        this.options.fetchImpl ?? fetch,
      );
    } catch (error) {
      remoteWarning = `本地凭据已清理，但 OpenAI refresh token 远端撤销失败: ${compactOAuthError(error)}`;
    }
    await this.options.vault.revokeSecret(credentialRef, systemVaultCaller('revoke'));
    return remoteWarning ? { remoteWarning } : {};
  }

  async getStatus(): Promise<CodexCredentialStatus> {
    const config = this.getConfiguration();
    if (!config.credentialRef) return { configured: false, connected: false };
    try {
      const bundle = await this.readBundle(config.credentialRef);
      return {
        configured: true,
        // access token 到期不等于账号断开：refresh token 会在下一次模型请求前自动续期。
        connected: true,
        accountBindingHash: hashAccountBinding(bundle.accountId),
        accountIdHint: bundle.accountId.slice(-6),
        ...(extractJwtEmail(bundle.idToken ?? bundle.accessToken)
          ? { email: extractJwtEmail(bundle.idToken ?? bundle.accessToken) }
          : {}),
        expiresAt: bundle.expiresAt,
        accessTokenExpired: isExpired(bundle),
        generation: bundle.generation,
      };
    } catch (error) {
      return {
        configured: true,
        connected: false,
        error: compactOAuthError(error),
      };
    }
  }

  getRuntimeStatus(): CodexSubscriptionRuntimeStatus {
    return this.telemetry.snapshot();
  }

  recordModelResult(input: Parameters<CodexSubscriptionTelemetry['recordResult']>[0]): void {
    this.telemetry.recordResult(input);
  }

  recordModelFailure(model: string, error: unknown): void {
    this.telemetry.recordFailure(model, error);
  }

  recordWireRequest(input: CodexWireRequestSample): void {
    this.telemetry.recordWireRequest(input);
  }

  private async refreshUnderLock(
    credentialRef: string,
    observed: CodexTokenBundle,
    forceRefresh: boolean,
    staleGeneration?: number,
  ): Promise<CodexTokenBundle> {
    const lock = this.options.lock ?? new LocalCodexCredentialLock();
    return lock.runExclusive(`agent-saas:codex-oauth:${credentialRef}`, async () => {
      const latest = await this.readBundle(credentialRef);
      if (
        forceRefresh
        && staleGeneration !== undefined
        && latest.generation > staleGeneration
        && !isExpiring(latest)
      ) {
        return latest;
      }
      if (latest.generation > observed.generation && !isExpiring(latest)) return latest;
      if (!forceRefresh && !isExpiring(latest)) return latest;

      try {
        const refreshed = await refreshCodexTokens(
          latest.refreshToken,
          this.options.fetchImpl ?? fetch,
        );
        const next: CodexTokenBundle = {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken || latest.refreshToken,
          ...(refreshed.idToken ? { idToken: refreshed.idToken } : latest.idToken ? { idToken: latest.idToken } : {}),
          expiresAt: refreshed.expiresAt,
          accountId: extractCodexAccountId(
            refreshed.accessToken,
            refreshed.idToken ?? latest.idToken,
            latest.accountId,
          ),
          generation: latest.generation + 1,
        };
        await this.options.vault.rotateSecret(
          credentialRef,
          JSON.stringify(next),
          systemVaultCaller('rotate'),
        );
        this.telemetry.recordRefreshSuccess(next.generation);
        return next;
      } catch (error) {
        this.telemetry.recordRefreshFailure(error);
        throw error;
      }
    });
  }

  private async readBundle(credentialRef: string): Promise<CodexTokenBundle> {
    const raw = await this.options.vault.getSecret(credentialRef, systemVaultCaller('read'));
    return parseTokenBundle(raw);
  }
}

export async function refreshCodexTokens(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexOAuthTokens> {
  let response: Response;
  try {
    response = await fetchImpl(`${CODEX_AUTH_BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
        scope: 'openid profile email',
      }),
    });
  } catch (error) {
    throw new Error(`Codex OAuth refresh 网络失败: ${compactOAuthError(error)}`);
  }
  return readOAuthTokenResponse(response, 'refresh');
}

export async function readOAuthTokenResponse(
  response: Response,
  operation: 'exchange' | 'refresh',
): Promise<CodexOAuthTokens> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Codex OAuth ${operation} 失败（HTTP ${response.status}）: ${compactOAuthError(text)}`);
  }
  const payload = await response.json() as Record<string, unknown>;
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : '';
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : Number(payload.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(`Codex OAuth ${operation} 响应缺少 access_token/expires_in`);
  }
  if (operation === 'exchange' && !refreshToken) {
    throw new Error('Codex OAuth exchange 响应缺少 refresh_token');
  }
  if (operation === 'exchange' && typeof payload.id_token !== 'string') {
    throw new Error('Codex OAuth exchange 响应缺少 id_token');
  }
  return {
    accessToken,
    refreshToken,
    ...(typeof payload.id_token === 'string' ? { idToken: payload.id_token } : {}),
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

export async function revokeCodexRefreshToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${CODEX_AUTH_BASE_URL}/oauth/revoke`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: CODEX_OAUTH_CLIENT_ID,
    }),
  });
  if (!response.ok) {
    throw new Error(`Codex OAuth revoke 失败（HTTP ${response.status}）`);
  }
}

export function extractCodexAccountId(
  accessToken: string,
  idToken?: string,
  fallbackAccountId?: string,
): string {
  const fromIdToken = extractAccountIdClaim(decodeJwtPayload(idToken ?? ''));
  if (fromIdToken) return fromIdToken;
  const fromAccessToken = extractAccountIdClaim(decodeJwtPayload(accessToken));
  if (fromAccessToken) return fromAccessToken;
  if (fallbackAccountId?.trim()) return fallbackAccountId.trim();
  throw new Error('Codex OAuth token 缺少 chatgpt_account_id');
}

function extractAccountIdClaim(payload: Record<string, unknown> | null): string | undefined {
  const direct = payload?.chatgpt_account_id;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const auth = payload?.['https://api.openai.com/auth'];
  const accountId = auth && typeof auth === 'object'
    ? (auth as Record<string, unknown>).chatgpt_account_id
    : undefined;
  if (typeof accountId === 'string' && accountId.trim()) return accountId.trim();
  const organizations = payload?.organizations;
  if (Array.isArray(organizations)) {
    const firstId = organizations.find((organization) => (
      organization
      && typeof organization === 'object'
      && typeof (organization as Record<string, unknown>).id === 'string'
    ));
    if (firstId) {
      return ((firstId as Record<string, unknown>).id as string).trim() || undefined;
    }
  }
  return undefined;
}

export function hashAccountBinding(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 32);
}

function parseTokenBundle(raw: string): CodexTokenBundle {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('Codex OAuth 凭据格式损坏');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Codex OAuth 凭据格式损坏');
  }
  const value = payload as Record<string, unknown>;
  if (
    typeof value.accessToken !== 'string'
    || typeof value.refreshToken !== 'string'
    || typeof value.accountId !== 'string'
    || typeof value.expiresAt !== 'string'
    || typeof value.generation !== 'number'
  ) {
    throw new Error('Codex OAuth 凭据字段不完整');
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    ...(typeof value.idToken === 'string' ? { idToken: value.idToken } : {}),
    accountId: value.accountId,
    expiresAt: value.expiresAt,
    generation: value.generation,
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractJwtEmail(token: string): string | undefined {
  const email = decodeJwtPayload(token)?.email;
  return typeof email === 'string' && email.includes('@') ? email : undefined;
}

function isExpiring(bundle: CodexTokenBundle): boolean {
  const expiresAt = Date.parse(bundle.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt - Date.now() <= REFRESH_EARLY_MS;
}

function isExpired(bundle: CodexTokenBundle): boolean {
  const expiresAt = Date.parse(bundle.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

export function validateCodexEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Codex Responses endpoint 不是合法 URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Codex Responses endpoint 必须是无内嵌凭据的 HTTPS URL');
  }
  if (url.hostname !== 'chatgpt.com' || url.pathname !== '/backend-api/codex/responses') {
    throw new Error('Codex Responses endpoint 只允许 chatgpt.com/backend-api/codex/responses');
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function validateOriginator(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(normalized)) {
    throw new Error('Codex originator 必须是 2–64 位字母、数字、点、下划线或连字符');
  }
  return normalized;
}

function compactOAuthError(value: unknown): string {
  return (value instanceof Error ? value.message : String(value ?? ''))
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:access|refresh|id)_token["'\s:=]+[A-Za-z0-9._-]+/gi, '[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
