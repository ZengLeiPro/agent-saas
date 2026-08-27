import { createHash } from 'node:crypto';

import type { UserInfo } from '../data/users/types.js';
import type { SecretVault, VaultCaller, VaultOperation } from '../security/secretVault.js';
import type {
  FeishuAuthCheckResult,
  FeishuConnectionIdentity,
  FeishuConnectionRecord,
  FeishuConnectionStore,
  FeishuLoginMetadata,
} from './store.js';

const DEVICE_AUTHORIZATION_URL = 'https://accounts.feishu.cn/oauth/v1/device_authorization';
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const REVOKE_URL = 'https://accounts.feishu.cn/oauth/v1/revoke';
const USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_WINDOW_MS = 5 * 60 * 1_000;
const OAUTH_REQUEST_TIMEOUT_MS = 20_000;
const TOKEN_SECRET_KIND = 'feishu_token_bundle';
const CONNECTOR_ID = 'feishu';

export interface FeishuDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface FeishuOAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  scope: string;
  tokenType: string;
}

export interface FeishuUserIdentity {
  openId: string;
  name?: string;
  unionId?: string;
  userId?: string;
  tenantKey?: string;
}

export interface FeishuTokenBundle {
  version: 1;
  secretId: string;
  connector: 'feishu';
  tenantId: string;
  userId: string;
  username: string;
  appId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshExpiresAt: string;
  scope: string;
  tokenType: string;
  user: FeishuUserIdentity;
}

export type FeishuDeviceTokenResult =
  | { status: 'pending' | 'slow_down' }
  | { status: 'success'; token: FeishuOAuthToken }
  | { status: 'denied' | 'expired'; error: string };

export class FeishuOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'FeishuOAuthError';
  }
}

/** Server-only implementation of the wire protocol used by @larksuite/cli@1.0.90. */
export class FeishuOAuthClient {
  constructor(private readonly options: {
    appId: string;
    appSecret: string;
    fetchImpl: typeof fetch;
  }) {}

  get appId(): string {
    return this.options.appId;
  }

  async startDeviceAuthorization(scope = 'offline_access', signal?: AbortSignal): Promise<FeishuDeviceAuthorization> {
    const normalizedScope = forceOfflineAccess(scope);
    const body = new URLSearchParams({ client_id: this.options.appId, scope: normalizedScope });
    const response = await this.options.fetchImpl(DEVICE_AUTHORIZATION_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.options.appId}:${this.options.appSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: requestSignal(signal),
    });
    const data = await readJson(response, 'device authorization');
    throwForResponse(response, data, 'device authorization');
    const deviceCode = requiredString(data.device_code, 'device_code');
    const userCode = requiredString(data.user_code, 'user_code');
    const verificationUri = requiredString(data.verification_uri, 'verification_uri');
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: optionalString(data.verification_uri_complete)
        ?? appendDeviceUserCode(verificationUri, userCode),
      expiresIn: positiveInt(data.expires_in, 240),
      interval: positiveInt(data.interval, 5),
    };
  }

  async exchangeDeviceCode(deviceCode: string, signal?: AbortSignal): Promise<FeishuDeviceTokenResult> {
    const data = await this.postToken(new URLSearchParams({
      grant_type: DEVICE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: this.options.appId,
      client_secret: this.options.appSecret,
    }), signal);
    const error = optionalString(data.error);
    if (!error && optionalString(data.access_token)) return { status: 'success', token: parseToken(data) };
    if (error === 'authorization_pending') return { status: 'pending' };
    if (error === 'slow_down') return { status: 'slow_down' };
    if (error === 'access_denied') {
      return { status: 'denied', error: optionalString(data.error_description) ?? 'Authorization denied by user' };
    }
    if (error === 'expired_token' || error === 'invalid_grant') {
      return { status: 'expired', error: optionalString(data.error_description) ?? 'Device code expired' };
    }
    throw oauthError(data, 'device token exchange');
  }

  async refreshToken(refreshToken: string, signal?: AbortSignal): Promise<FeishuOAuthToken> {
    const data = await this.postToken(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.options.appId,
      client_secret: this.options.appSecret,
    }), signal);
    if (optionalString(data.error) || (numericCode(data.code) ?? 0) !== 0) {
      throw oauthError(data, 'token refresh');
    }
    return parseToken(data);
  }

  async revoke(token: string, tokenTypeHint = 'refresh_token', signal?: AbortSignal): Promise<void> {
    const response = await this.options.fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.options.appId,
        client_secret: this.options.appSecret,
        token,
        token_type_hint: tokenTypeHint,
      }),
      signal: requestSignal(signal),
    });
    if (response.status === 204) return;
    const data = await readJson(response, 'token revoke', true);
    throwForResponse(response, data, 'token revoke');
    if ((numericCode(data.code) ?? 0) !== 0 || optionalString(data.error)) throw oauthError(data, 'token revoke');
  }

  async getUserInfo(accessToken: string, signal?: AbortSignal): Promise<FeishuUserIdentity> {
    const response = await this.options.fetchImpl(USER_INFO_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
      signal: requestSignal(signal),
    });
    const data = await readJson(response, 'user info');
    throwForResponse(response, data, 'user info');
    if ((numericCode(data.code) ?? -1) !== 0) throw oauthError(data, 'user info');
    const user = objectValue(data.data);
    return {
      openId: requiredString(user.open_id, 'open_id'),
      ...(optionalString(user.name) ? { name: optionalString(user.name) } : {}),
      ...(optionalString(user.union_id) ? { unionId: optionalString(user.union_id) } : {}),
      ...(optionalString(user.user_id) ? { userId: optionalString(user.user_id) } : {}),
      ...(optionalString(user.tenant_key) ? { tenantKey: optionalString(user.tenant_key) } : {}),
    };
  }

  private async postToken(body: URLSearchParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.options.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: requestSignal(signal),
    });
    const data = await readJson(response, 'token endpoint');
    if (!response.ok && !optionalString(data.error)) throwForResponse(response, data, 'token endpoint');
    return data;
  }
}

export interface FeishuTokenBrokerLike {
  ensureFresh(identity: FeishuConnectionIdentity): Promise<FeishuTokenBundle>;
  verify(identity: FeishuConnectionIdentity, signal?: AbortSignal): Promise<FeishuAuthCheckResult>;
}

export class FeishuTokenBroker implements FeishuTokenBrokerLike {
  private readonly refreshFlights = new Map<string, Promise<FeishuTokenBundle>>();
  private readonly now: () => Date;
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: {
    oauth: FeishuOAuthClient;
    vault: SecretVault;
    connectionStore: FeishuConnectionStore;
    scope?: string;
    profileId?: string;
    now?: () => Date;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    onError?: (error: Error) => void;
  }) {
    this.now = options.now ?? (() => new Date());
    this.wait = options.wait ?? abortableDelay;
  }

  get appId(): string {
    return this.options.oauth.appId;
  }

  get profileId(): string {
    return this.options.profileId ?? 'default';
  }

  async authorize(
    identity: FeishuConnectionIdentity,
    onAuthorizationUrl: (url: string) => void | Promise<void>,
    signal?: AbortSignal,
    scope?: string,
  ): Promise<FeishuLoginMetadata> {
    const device = await this.options.oauth.startDeviceAuthorization(
      scope ?? this.options.scope ?? 'offline_access',
      signal,
    );
    await onAuthorizationUrl(device.verificationUriComplete);
    const deadline = this.now().getTime() + device.expiresIn * 1_000;
    let intervalSeconds = Math.max(1, device.interval);
    let token: FeishuOAuthToken | undefined;
    for (let attempts = 0; attempts < 600 && this.now().getTime() < deadline; attempts += 1) {
      await this.wait(intervalSeconds * 1_000, signal);
      const result = await this.options.oauth.exchangeDeviceCode(device.deviceCode, signal);
      if (result.status === 'pending') continue;
      if (result.status === 'slow_down') {
        intervalSeconds = Math.min(60, intervalSeconds + 5);
        continue;
      }
      if (result.status === 'denied') throw new FeishuOAuthError('access_denied', result.error);
      if (result.status === 'expired') throw new FeishuOAuthError('expired_token', result.error);
      if (result.status === 'success') {
        token = result.token;
        break;
      }
    }
    if (!token) throw new FeishuOAuthError('expired_token', 'Device authorization expired');
    const user = await this.options.oauth.getUserInfo(token.accessToken, signal);
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    const requiredScopes = forceOfflineAccess(scope ?? this.options.scope ?? 'offline_access');
    if (!token.refreshToken || !hasRequiredScopes(token.scope, requiredScopes)) {
      const revokeToken = token.refreshToken || token.accessToken;
      await this.revokeProviderWithRetry(
        revokeToken,
        token.refreshToken ? 'refresh_token' : 'access_token',
        signal,
      ).catch(error => this.report(error));
      throw new FeishuOAuthError(
        'insufficient_grant',
        '飞书未返回 refresh token 或缺少必需 scope，请检查应用权限后重新授权',
      );
    }
    const bundle = this.toBundle(identity, token, user);
    try {
      return await this.persistConnectedToken(identity, bundle);
    } catch (error) {
      const revokeToken = token.refreshToken || token.accessToken;
      if (revokeToken) {
        await this.revokeProviderWithRetry(
          revokeToken,
          token.refreshToken ? 'refresh_token' : 'access_token',
          signal,
        ).catch(revokeError => this.report(revokeError));
      }
      throw error;
    }
  }

  async ensureFresh(identity: FeishuConnectionIdentity): Promise<FeishuTokenBundle> {
    const connection = await this.findConnection(identity);
    if (!connection.tokenSecretRef || !connection.brokerSecretId || connection.connectionStatus === 'disconnected') {
      throw new FeishuOAuthError('reauthorization_required', 'Feishu connection requires authorization');
    }
    const bundle = await this.readBundle(identity, connection);
    if (Date.parse(bundle.expiresAt) > this.now().getTime() + REFRESH_WINDOW_MS) return bundle;

    const key = `${identity.tenantId}\0${identity.userId}\0${connection.profileId}`;
    const existing = this.refreshFlights.get(key);
    if (existing) return existing;
    const flight = this.refreshWithLock(identity, connection.profileId).finally(() => {
      if (this.refreshFlights.get(key) === flight) this.refreshFlights.delete(key);
    });
    this.refreshFlights.set(key, flight);
    return flight;
  }

  async verify(identity: FeishuConnectionIdentity, signal?: AbortSignal): Promise<FeishuAuthCheckResult> {
    const bundle = await this.ensureFresh(identity);
    const user = await this.options.oauth.getUserInfo(bundle.accessToken, signal);
    assertSameFeishuUser(bundle.user, user);
    return {
      authenticated: true,
      verified: true,
      tokenStatus: 'valid',
      userOpenId: user.openId,
      ...(user.name ? { userName: user.name } : {}),
      scope: bundle.scope,
      expiresAt: bundle.expiresAt,
      refreshExpiresAt: bundle.refreshExpiresAt,
    };
  }

  async revokeUser(identity: FeishuConnectionIdentity, signal?: AbortSignal): Promise<void> {
    const connections = await this.options.connectionStore.listForUser(identity.tenantId, identity.userId);
    const brokerConnections = connections.filter(connection => connection.tokenSecretRef && connection.brokerSecretId);
    if (brokerConnections.length > 0
      && (!this.options.connectionStore.markBrokerProviderRevoked || !this.options.connectionStore.markBrokerRevoked)) {
      throw new Error('飞书撤销状态存储尚未配置');
    }
    let firstError: unknown;
    for (const connection of brokerConnections) {
      try {
        if (connection.tokenStatus !== 'provider_revoked' && connection.tokenStatus !== 'revoked') {
          if (connection.appId !== this.appId) {
            throw new FeishuOAuthError(
              'app_mismatch',
              '飞书 App ID 已变更；必须使用旧应用凭据撤销现有连接',
            );
          }
          const bundle = await this.readBundle(identity, connection);
          const token = bundle.refreshToken || bundle.accessToken;
          if (token) {
            await this.revokeProviderWithRetry(
              token,
              bundle.refreshToken ? 'refresh_token' : 'access_token',
              signal,
            );
          }
          await this.options.connectionStore.markBrokerProviderRevoked!(identity, connection.profileId);
        }
        if (connection.tokenStatus !== 'revoked') {
          await this.options.vault.revokeSecret(connection.tokenSecretRef!, vaultCaller(identity, 'revoke'));
          await this.options.connectionStore.markBrokerRevoked!(identity, connection.profileId);
        }
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  async listLegacyProfileIds(
    identity: FeishuConnectionIdentity,
    requestedProfileIds: string[] = [],
  ): Promise<string[]> {
    const requested = requestedProfileIds.length > 0 ? new Set(requestedProfileIds) : undefined;
    const connections = await this.options.connectionStore.listForUser(identity.tenantId, identity.userId);
    return connections
      .filter(connection => (!requested || requested.has(connection.profileId)))
      .filter(connection => !connection.tokenSecretRef && !connection.brokerSecretId)
      .map(connection => connection.profileId);
  }

  async removeLegacyProfiles(identity: FeishuConnectionIdentity, profileIds: string[]): Promise<void> {
    if (!this.options.connectionStore.removeLegacyProfile) {
      throw new Error('飞书旧版连接清理存储尚未配置');
    }
    for (const profileId of profileIds) {
      await this.options.connectionStore.removeLegacyProfile(identity, profileId);
    }
  }

  private async refreshWithLock(
    identity: FeishuConnectionIdentity,
    profileId: string,
  ): Promise<FeishuTokenBundle> {
    const refresh = async (): Promise<FeishuTokenBundle> => {
      // 取得跨进程 advisory lock 后强制绕过当前进程 Vault cache，避免消费其他进程刚轮换掉的旧 refresh token。
      const connection = await this.findConnection(identity);
      if (connection.tokenSecretRef) this.options.vault.invalidate?.(connection.tokenSecretRef);
      const current = await this.readBundle(identity, connection);
      if (Date.parse(current.expiresAt) > this.now().getTime() + REFRESH_WINDOW_MS) return current;
      return await this.refresh(identity, connection, current);
    };
    if (!this.options.connectionStore.withBrokerRefreshLock) return await refresh();
    try {
      return await this.options.connectionStore.withBrokerRefreshLock(identity, profileId, refresh);
    } catch (error) {
      if (isStatementTimeout(error)) {
        throw new FeishuOAuthError('refresh_in_progress', 'Feishu token refresh is already in progress', true);
      }
      throw error;
    }
  }

  private async refresh(
    identity: FeishuConnectionIdentity,
    connection: FeishuConnectionRecord,
    current: FeishuTokenBundle,
  ): Promise<FeishuTokenBundle> {
    if (!current.refreshToken || Date.parse(current.refreshExpiresAt) <= this.now().getTime()) {
      await this.invalidate(identity, connection, 'refresh_token_expired');
      throw new FeishuOAuthError('invalid_grant', 'Feishu refresh token expired');
    }

    let token: FeishuOAuthToken;
    try {
      token = await this.options.oauth.refreshToken(current.refreshToken);
    } catch (error) {
      if (error instanceof FeishuOAuthError && error.code === 'invalid_grant') {
        await this.invalidate(identity, connection, 'invalid_grant');
      }
      throw error;
    }
    if (token.scope && !hasRequiredScopes(token.scope, current.scope)) {
      const revokeToken = token.refreshToken || token.accessToken;
      await this.revokeProviderWithRetry(
        revokeToken,
        token.refreshToken ? 'refresh_token' : 'access_token',
      ).catch(error => this.report(error));
      await this.invalidate(identity, connection, 'insufficient_grant');
      throw new FeishuOAuthError(
        'insufficient_grant',
        '飞书 refresh 后缺少原业务 scope，请重新授权',
      );
    }
    const refreshed = this.toBundle(identity, {
      ...token,
      refreshToken: token.refreshToken || current.refreshToken,
      refreshExpiresIn: token.refreshExpiresIn > 0
        ? token.refreshExpiresIn
        : Math.max(0, Math.floor((Date.parse(current.refreshExpiresAt) - this.now().getTime()) / 1_000)),
      scope: token.scope || current.scope,
      tokenType: token.tokenType || current.tokenType,
    }, current.user, current.secretId);

    try {
      await this.rotateBundleWithRetry(connection.tokenSecretRef!, refreshed, identity);
    } catch {
      // Provider 已可能消费旧 refresh token；新 token 无法进入 Vault 时先远端撤销，
      // 再把连接标成失效，避免留下未知的有效凭据或继续向 sandbox 注入旧 token。
      const revokeToken = refreshed.refreshToken || refreshed.accessToken;
      if (revokeToken) {
        await this.revokeProviderWithRetry(
          revokeToken,
          refreshed.refreshToken ? 'refresh_token' : 'access_token',
        ).catch(error => this.report(error));
      }
      await this.invalidate(identity, connection, 'token_persistence_failed');
      throw new FeishuOAuthError('token_persistence_failed', 'Feishu token 持久化失败，请重新授权');
    }

    try {
      await this.options.connectionStore.updateBrokerToken?.(
        identity,
        connection.profileId,
        refreshed.expiresAt,
        refreshed.refreshExpiresAt,
        refreshed.scope,
      );
    } catch (error) {
      // Vault bundle 是 token 真值来源。DB 仅保存非敏感过期时间；后续 fresh read 会补齐。
      this.report(error);
    }
    return refreshed;
  }

  private async rotateBundleWithRetry(
    tokenSecretRef: string,
    bundle: FeishuTokenBundle,
    identity: FeishuConnectionIdentity,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.options.vault.rotateSecret(tokenSecretRef, JSON.stringify(bundle), vaultCaller(identity, 'rotate'));
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await this.wait(250 * (attempt + 1));
      }
    }
    throw lastError;
  }

  private async revokeProviderWithRetry(
    token: string,
    tokenTypeHint: 'access_token' | 'refresh_token',
    signal?: AbortSignal,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.options.oauth.revoke(token, tokenTypeHint, signal);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await this.wait(250 * (attempt + 1), signal);
      }
    }
    throw lastError;
  }

  private async persistConnectedToken(
    identity: FeishuConnectionIdentity,
    bundle: FeishuTokenBundle,
  ): Promise<FeishuLoginMetadata> {
    const existing = (await this.options.connectionStore.listForUser(identity.tenantId, identity.userId))
      .find(item => item.profileId === this.profileId);
    if (existing && existing.appId !== this.appId) {
      throw new FeishuOAuthError(
        'app_mismatch',
        '飞书 App ID 已变更；请先使用旧应用凭据撤销现有连接，再切换配置',
      );
    }
    let oldPlaintext: string | undefined;
    if (existing?.tokenSecretRef) {
      try {
        oldPlaintext = await this.options.vault.getSecret(existing.tokenSecretRef, vaultCaller(identity, 'read'));
      } catch (error) {
        if (existing.connectionStatus !== 'disconnected') throw error;
        // 已失效连接允许重新授权，但必须先确认旧 ref 已撤销；Vault 故障则阻断，避免孤儿 token。
        await this.options.vault.revokeSecret(existing.tokenSecretRef, vaultCaller(identity, 'revoke'));
      }
    }
    if (existing && existing.connectionStatus !== 'disconnected') {
      try {
        if (existing.userOpenId !== bundle.user.openId) throw new Error('open identity mismatch');
        if (oldPlaintext) assertSameFeishuUser(parseBundleUser(oldPlaintext), bundle.user);
      } catch {
        throw new FeishuOAuthError(
          'identity_mismatch',
          '当前平台账号已绑定其他飞书身份，请先断开后再重新授权',
        );
      }
    }
    const baseLogin: Omit<FeishuLoginMetadata, 'tokenSecretRef'> = {
      profileId: this.profileId,
      appId: this.appId,
      userOpenId: bundle.user.openId,
      ...(bundle.user.name ? { userName: bundle.user.name } : {}),
      scope: bundle.scope,
      expiresAt: bundle.expiresAt,
      refreshExpiresAt: bundle.refreshExpiresAt,
      brokerSecretId: bundle.secretId,
    };
    if (existing?.tokenSecretRef && oldPlaintext !== undefined) {
      const login = { ...baseLogin, tokenSecretRef: existing.tokenSecretRef };
      // 先提交仍指向旧有效 bundle 的 PG 元数据，再原子 rotate Vault。中途失败不会暴露随后被补偿撤销的新 token。
      await this.options.connectionStore.upsertLogin(identity, login, this.now());
      await this.options.vault.rotateSecret(
        existing.tokenSecretRef,
        JSON.stringify(bundle),
        vaultCaller(identity, 'rotate'),
      );
      return login;
    }
    const ref = await this.options.vault.putSecret(
      identity.userId,
      TOKEN_SECRET_KIND,
      JSON.stringify(bundle),
      vaultCaller(identity, 'write'),
      {
        secretId: bundle.secretId,
        connector: CONNECTOR_ID,
        tenantId: identity.tenantId,
        userId: identity.userId,
        username: identity.username,
        appId: this.appId,
      },
    );
    const login = { ...baseLogin, tokenSecretRef: ref.id };
    try {
      await this.options.connectionStore.upsertLogin(identity, login, this.now());
      return login;
    } catch (error) {
      await this.options.vault.revokeSecret(ref.id, vaultCaller(identity, 'revoke')).catch(revokeError => this.report(revokeError));
      throw error;
    }
  }

  private async readBundle(
    identity: FeishuConnectionIdentity,
    connection: FeishuConnectionRecord,
  ): Promise<FeishuTokenBundle> {
    const plaintext = await this.options.vault.getSecret(connection.tokenSecretRef!, vaultCaller(identity, 'read'));
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new Error('Invalid Feishu token bundle');
    }
    const bundle = parsed as Partial<FeishuTokenBundle>;
    const expectedSecretId = deterministicFeishuSecretId(identity);
    if (
      bundle.version !== 1
      || bundle.secretId !== expectedSecretId
      || connection.brokerSecretId !== expectedSecretId
      || bundle.connector !== CONNECTOR_ID
      || bundle.tenantId !== identity.tenantId
      || bundle.userId !== identity.userId
      || bundle.username !== identity.username
      || bundle.appId !== this.appId
      || typeof bundle.accessToken !== 'string'
      || typeof bundle.refreshToken !== 'string'
      || typeof bundle.expiresAt !== 'string'
      || typeof bundle.refreshExpiresAt !== 'string'
      || typeof bundle.scope !== 'string'
      || typeof bundle.tokenType !== 'string'
      || !bundle.user
      || typeof bundle.user.openId !== 'string'
    ) {
      throw new Error('Feishu token bundle scope mismatch');
    }
    return bundle as FeishuTokenBundle;
  }

  private async findConnection(identity: FeishuConnectionIdentity): Promise<FeishuConnectionRecord> {
    const connections = await this.options.connectionStore.listForUser(identity.tenantId, identity.userId);
    const connection = connections.find(item => item.profileId === this.profileId);
    if (!connection) throw new FeishuOAuthError('reauthorization_required', 'Feishu connection requires authorization');
    if (connection.appId !== this.appId) {
      throw new FeishuOAuthError(
        'app_mismatch',
        '飞书 App ID 已变更；请先使用旧应用凭据撤销现有连接，再切换配置',
      );
    }
    return connection;
  }

  private async invalidate(
    identity: FeishuConnectionIdentity,
    connection: FeishuConnectionRecord,
    reason: string,
  ): Promise<void> {
    try {
      await this.options.connectionStore.invalidateBroker?.(identity, connection.profileId, reason);
    } catch (error) {
      this.report(error);
    }
    try {
      await this.options.vault.revokeSecret(connection.tokenSecretRef!, vaultCaller(identity, 'revoke'));
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  private toBundle(
    identity: FeishuConnectionIdentity,
    token: FeishuOAuthToken,
    user: FeishuUserIdentity,
    secretId = deterministicFeishuSecretId(identity),
  ): FeishuTokenBundle {
    const nowMs = this.now().getTime();
    return {
      version: 1,
      secretId,
      connector: CONNECTOR_ID,
      tenantId: identity.tenantId,
      userId: identity.userId,
      username: identity.username,
      appId: this.appId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: new Date(nowMs + Math.max(0, token.expiresIn) * 1_000).toISOString(),
      refreshExpiresAt: new Date(nowMs + Math.max(0, token.refreshExpiresIn) * 1_000).toISOString(),
      scope: forceOfflineAccess(token.scope),
      tokenType: token.tokenType || 'Bearer',
      user,
    };
  }
}

/** AuthFlow adapter; persistence is done transactionally by the broker itself. */
export class FeishuTokenBrokerLoginRunner {
  readonly persistsConnection = true;

  constructor(
    private readonly broker: FeishuTokenBroker,
    private readonly options: {
      legacyLogout?: (user: UserInfo, profileIds: string[]) => Promise<void>;
    } = {},
  ) {}

  async login(
    user: UserInfo,
    onAuthorization: (authorization: { authorizationUrl: string }) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<FeishuLoginMetadata> {
    const identity = toIdentity(user);
    const legacyProfileIds = await this.broker.listLegacyProfileIds(identity, [this.broker.profileId]);
    if (legacyProfileIds.length > 0) {
      if (!this.options.legacyLogout) throw new Error('飞书旧版凭据清理服务尚未配置');
      await this.options.legacyLogout(user, legacyProfileIds);
      await this.broker.removeLegacyProfiles(identity, legacyProfileIds);
    }
    return await this.broker.authorize(identity, url => onAuthorization({ authorizationUrl: url }), signal);
  }

  async logout(user: UserInfo, profileIds: string[]): Promise<void> {
    const identity = toIdentity(user);
    const legacyProfileIds = await this.broker.listLegacyProfileIds(identity, profileIds);
    if (legacyProfileIds.length > 0) {
      if (!this.options.legacyLogout) throw new Error('飞书旧版凭据清理服务尚未配置');
      await this.options.legacyLogout(user, legacyProfileIds);
    }
    await this.broker.revokeUser(identity);
  }
}

export class FeishuTokenBrokerStatusRunner {
  constructor(private readonly broker: FeishuTokenBroker) {}

  async check(
    user: UserInfo,
    connection: FeishuConnectionRecord,
    signal?: AbortSignal,
  ): Promise<FeishuAuthCheckResult> {
    if (connection.appId !== this.broker.appId) throw new Error('Feishu app identity mismatch');
    const result = await this.broker.verify(toIdentity(user), signal);
    if (result.userOpenId && result.userOpenId !== connection.userOpenId) {
      throw new Error('Feishu connection identity mismatch');
    }
    return result;
  }
}

export function deterministicFeishuSecretId(identity: FeishuConnectionIdentity): string {
  const digest = createHash('sha256')
    .update(`${CONNECTOR_ID}\0${identity.tenantId}\0${identity.userId}\0${identity.username}`)
    .digest('hex');
  return `feishu-token-${digest}`;
}

function toIdentity(user: UserInfo): FeishuConnectionIdentity {
  return { tenantId: user.tenantId, userId: user.id, username: user.username };
}

function parseBundleUser(plaintext: string): FeishuUserIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('Invalid Feishu token bundle');
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
  const user = record?.user && typeof record.user === 'object' && !Array.isArray(record.user)
    ? record.user as Record<string, unknown>
    : undefined;
  const openId = user ? optionalString(user.openId) : undefined;
  if (!user || !openId) throw new Error('Invalid Feishu token bundle identity');
  return {
    openId,
    ...(optionalString(user.unionId) ? { unionId: optionalString(user.unionId)! } : {}),
    ...(optionalString(user.tenantKey) ? { tenantKey: optionalString(user.tenantKey)! } : {}),
    ...(optionalString(user.name) ? { name: optionalString(user.name)! } : {}),
  };
}

function assertSameFeishuUser(expected: FeishuUserIdentity, actual: FeishuUserIdentity): void {
  if (actual.openId !== expected.openId) throw new Error('Feishu user identity mismatch');
  if (expected.unionId && actual.unionId !== expected.unionId) {
    throw new Error('Feishu union identity mismatch');
  }
  if (expected.tenantKey && actual.tenantKey !== expected.tenantKey) {
    throw new Error('Feishu tenant identity mismatch');
  }
}

function vaultCaller(identity: FeishuConnectionIdentity, operation: VaultOperation): VaultCaller {
  return {
    actor: 'connector_proxy',
    userId: identity.userId,
    tenantId: identity.tenantId,
    scopes: [`secret:${TOKEN_SECRET_KIND}:${operation}`],
  };
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isStatementTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '57014');
}

function appendDeviceUserCode(verificationUri: string, userCode: string): string {
  const url = new URL(verificationUri);
  if (!url.searchParams.has('user_code')) url.searchParams.set('user_code', userCode);
  return url.toString();
}

function forceOfflineAccess(scope: string): string {
  const values = new Set(scope.split(/[\s,]+/).map(value => value.trim()).filter(Boolean));
  values.add('offline_access');
  return [...values].join(' ');
}

function hasRequiredScopes(granted: string, required: string): boolean {
  const grantedSet = new Set(granted.split(/[\s,]+/).map(value => value.trim()).filter(Boolean));
  return required
    .split(/[\s,]+/)
    .map(value => value.trim())
    .filter(Boolean)
    .every(scope => grantedSet.has(scope));
}

function parseToken(data: Record<string, unknown>): FeishuOAuthToken {
  return {
    accessToken: requiredString(data.access_token, 'access_token'),
    refreshToken: optionalString(data.refresh_token) ?? '',
    expiresIn: positiveInt(data.expires_in, 7_200),
    refreshExpiresIn: positiveInt(data.refresh_token_expires_in, optionalString(data.refresh_token) ? 604_800 : positiveInt(data.expires_in, 7_200)),
    scope: optionalString(data.scope) ?? '',
    tokenType: optionalString(data.token_type) ?? 'Bearer',
  };
}

async function readJson(response: Response, operation: string, allowEmpty = false): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim() && allowEmpty) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return objectValue(value);
  } catch {
    throw new FeishuOAuthError('invalid_response', `Feishu ${operation} returned an invalid response`);
  }
}

function throwForResponse(response: Response, data: Record<string, unknown>, operation: string): void {
  if (response.ok && !optionalString(data.error)) return;
  throw oauthError(data, operation, response.status >= 500);
}

function oauthError(data: Record<string, unknown>, operation: string, retryable = false): FeishuOAuthError {
  const code = optionalString(data.error) ?? String(numericCode(data.code) ?? 'oauth_error');
  const description = optionalString(data.error_description)
    ?? optionalString(data.msg)
    ?? optionalString(data.message)
    ?? `Feishu ${operation} failed`;
  return new FeishuOAuthError(code, description, retryable);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) throw new FeishuOAuthError('invalid_response', `Feishu response is missing ${field}`);
  return result;
}

function numericCode(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function positiveInt(value: unknown, fallback: number): number {
  const number = Math.floor(numericCode(value) ?? fallback);
  return number > 0 ? number : fallback;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Aborted'));
    }, { once: true });
  });
}
