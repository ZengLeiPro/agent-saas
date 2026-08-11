import { randomBytes } from 'node:crypto';

import {
  auth as sdkAuth,
  type AuthResult,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import type {
  McpConfigStore,
  McpOAuthConnectionRecord,
  ManagedMcpServer,
} from '../data/mcpConfig.js';
import { isServerVisibleToUser } from '../data/mcpConfig.js';
import type { McpOAuthServerConfig } from './clientManager.js';
import { assertSafeMcpUrl } from './clientManager.js';
import type { SecretVault, VaultCaller, VaultOperation } from '../security/secretVault.js';

const OAUTH_SECRET_KIND = 'mcp_oauth';
const PENDING_TTL_MS = 10 * 60 * 1000;

interface OAuthBundle {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export interface McpOAuthSummary {
  provider: McpOAuthServerConfig['provider'];
  beta: boolean;
  platformConfigured: boolean;
  status: 'disconnected' | 'pending' | 'connected' | 'error';
  connectedAt?: string;
  updatedAt?: string;
  lastError?: string;
}

export interface McpOAuthStartResult {
  status: 'pending' | 'connected';
  authorizationUrl?: string;
  scopeSummary?: string[];
  requestedScopes?: string[];
  purpose?: string;
  riskLevel?: 'high';
  dataDestination?: string;
  revokeMethod?: string;
}

export interface McpOAuthFinishResult {
  ok: boolean;
  username: string;
  serverId: string;
  tenantId: string;
  redirectUrl: string;
  returnTo: string;
  scopeSummary?: string[];
  error?: string;
}

type AuthFunction = (provider: OAuthClientProvider, options: {
  serverUrl: string | URL;
  authorizationCode?: string;
  scope?: string;
}) => Promise<AuthResult>;

export interface McpOAuthServiceOptions {
  store: McpConfigStore;
  vault: SecretVault;
  authFn?: AuthFunction;
  env?: NodeJS.ProcessEnv;
  userResolver?: (username: string) => { id?: string; tenantId: string; disabled?: boolean } | undefined;
  authorizeSubject?: (userId: string, tenantId: string) => Promise<boolean>;
  authorizeGrant?: (grantId: string, userId: string, tenantId: string) => Promise<boolean>;
  authorizeConnect?: (userId: string, tenantId: string, connectorId: string) => Promise<boolean>;
  onSecretRotated?: (secretRef: string) => Promise<void>;
}

export class McpOAuthService {
  private readonly authFn: AuthFunction;
  private readonly env: NodeJS.ProcessEnv;
  private readonly connectionLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: McpOAuthServiceOptions) {
    this.authFn = options.authFn ?? sdkAuth;
    this.env = options.env ?? process.env;
  }

  summary(username: string, server: ManagedMcpServer): McpOAuthSummary | undefined {
    const oauth = oauthConfigOf(server);
    if (!oauth) return undefined;
    const record = this.options.store.getUserOAuthConnection(username, server.id);
    return {
      provider: oauth.provider,
      beta: oauth.beta === true,
      platformConfigured: this.isPlatformConfigured(oauth),
      status: record?.status ?? 'disconnected',
      connectedAt: record?.connectedAt,
      updatedAt: record?.updatedAt,
      lastError: record?.lastError,
    };
  }

  async start(args: {
    username: string;
    userId?: string;
    tenantId: string;
    server: ManagedMcpServer;
    redirectUrl: string;
    returnTo: string;
  }): Promise<McpOAuthStartResult> {
    const { username, tenantId, server } = args;
    if (args.userId && this.options.authorizeSubject
      && !await this.options.authorizeSubject(args.userId, tenantId)) throw new Error('OAuth subject is not active');
    if (!args.userId || !this.options.authorizeConnect
      || !await this.options.authorizeConnect(args.userId, tenantId, server.id)) {
      throw new Error('Connector assignment is unavailable');
    }
    if (!isServerVisibleToUser(server, username, tenantId)) throw new Error('MCP server not found');
    const oauth = oauthConfigOf(server);
    if (!oauth || !isHttpServer(server)) throw new Error('This MCP server does not support OAuth');
    assertSafeMcpUrl(server.config.url);
    this.assertPlatformConfigured(oauth);
    const requestedScopes = [...new Set((oauth.scopes ?? []).map(scope => scope.trim()).filter(Boolean))].sort();
    if (requestedScopes.length === 0) throw new Error('MCP OAuth requested scope authority is unavailable');

    const previous = this.options.store.getUserOAuthConnection(username, server.id);
    if (previous?.status === 'connected' && previous.secretRef) {
      if (!previous.grantedScopes?.length) throw new Error('OAuth granted scope evidence is unavailable');
      if (previous.grantedScopes.some(scope => !requestedScopes.includes(scope))) {
        throw new Error('OAuth granted scope exceeds the connector allowlist');
      }
      return { status: 'connected', scopeSummary: [...new Set(previous.grantedScopes)].sort() };
    }

    const now = new Date();
    const state = randomBytes(32).toString('base64url');
    const record: McpOAuthConnectionRecord = {
      serverId: server.id,
      tenantId,
      ...(args.userId ? { userId: args.userId } : {}),
      status: 'pending',
      secretRef: previous?.secretRef,
      pendingState: state,
      pendingExpiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
      redirectUrl: args.redirectUrl,
      returnTo: sanitizeReturnTo(args.returnTo),
      requestedScopes,
      updatedAt: now.toISOString(),
    };
    await this.options.store.setUserOAuthConnection(username, record);

    const provider = this.createProvider({ username, tenantId, server, record, oauth, allowRedirect: true });
    try {
      const result = await this.authFn(provider, {
        serverUrl: server.config.url,
        scope: requestedScopes.join(' '),
      });
      if (result === 'AUTHORIZED') {
        const tokenScope = (await this.readBundle(username, tenantId, server.id)).tokens?.scope;
        const scopeSummary = typeof tokenScope === 'string'
          ? [...new Set(tokenScope.split(/\s+/).map(scope => scope.trim()).filter(Boolean))].sort()
          : [];
        if (scopeSummary.length === 0) throw new Error('OAuth granted scope evidence is unavailable');
        if (scopeSummary.some(scope => !requestedScopes.includes(scope))) {
          throw new Error('OAuth granted scope exceeds the signed request');
        }
        await this.markConnected(username, record, scopeSummary);
        return { status: 'connected', scopeSummary };
      }
      const authorizationUrl = provider.authorizationUrl;
      if (!authorizationUrl) throw new Error('OAuth provider did not return an authorization URL');
      return {
        status: 'pending', authorizationUrl, requestedScopes,
        purpose: `仅在本人获指派且组织已授权的 Agent Run 中调用 ${server.name}`,
        riskLevel: 'high',
        dataDestination: `请求数据发送至 ${new URL(server.config.url).origin}，运行结果进入当前 Agent Run`,
        revokeMethod: '可在连接与授权页经影响预览撤销；撤销后新 Run 立即不可用',
      };
    } catch (error) {
      await this.markError(username, record, errorMessage(error));
      throw error;
    }
  }

  async finish(args: { state: string; code?: string; error?: string; errorDescription?: string }): Promise<McpOAuthFinishResult | undefined> {
    const found = this.options.store.findUserOAuthConnectionByState(args.state);
    if (!found) return undefined;
    const { username, connection } = found;
    const baseResult = {
      username,
      serverId: connection.serverId,
      tenantId: connection.tenantId,
      redirectUrl: connection.redirectUrl,
      returnTo: connection.returnTo,
    };

    // state 一次性消费；即使 token exchange 失败也不能重放。
    const consumed: McpOAuthConnectionRecord = {
      ...connection,
      pendingState: undefined,
      pendingExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.options.store.setUserOAuthConnection(username, consumed);

    const user = this.options.userResolver?.(username);
    if (this.options.userResolver && (!user || user.disabled || user.tenantId !== connection.tenantId
      || (connection.userId !== undefined && user.id !== connection.userId))) {
      const message = 'User or tenant changed during OAuth authorization';
      await this.markError(username, consumed, message);
      return { ok: false, ...baseResult, error: message };
    }
    if (connection.userId && this.options.authorizeSubject
      && !await this.options.authorizeSubject(connection.userId, connection.tenantId)) {
      const message = 'OAuth subject is not active';
      await this.markError(username, consumed, message);
      return { ok: false, ...baseResult, error: message };
    }
    if (!connection.userId || !this.options.authorizeConnect
      || !await this.options.authorizeConnect(connection.userId, connection.tenantId, connection.serverId)) {
      const message = 'Connector assignment is unavailable';
      await this.markError(username, consumed, message);
      return { ok: false, ...baseResult, error: message };
    }

    if (!connection.pendingExpiresAt || Date.parse(connection.pendingExpiresAt) <= Date.now()) {
      const message = 'OAuth authorization expired; please reconnect';
      await this.markError(username, consumed, message);
      return { ok: false, ...baseResult, error: message };
    }
    if (args.error) {
      const message = cleanError(`${args.error}${args.errorDescription ? `: ${args.errorDescription}` : ''}`);
      await this.markError(username, consumed, message);
      return { ok: false, ...baseResult, error: message };
    }
    if (!args.code) {
      const message = 'OAuth callback is missing authorization code';
      await this.markError(username, consumed, message);
      return { ok: false, ...baseResult, error: message };
    }

    const server = this.options.store.getServer(connection.serverId);
    const oauth = server ? oauthConfigOf(server) : undefined;
    if (!server || !oauth || !isHttpServer(server) || server.tenantId !== '*' && server.tenantId !== connection.tenantId) {
      const message = 'MCP connector is no longer available';
      await this.markError(username, consumed, message);
      return { ok: false, ...baseResult, error: message };
    }

    try {
      this.assertPlatformConfigured(oauth);
      const requestedScopes = [...new Set((consumed.requestedScopes ?? []).map(scope => scope.trim()).filter(Boolean))].sort();
      const connectorScopes = new Set((oauth.scopes ?? []).map(scope => scope.trim()).filter(Boolean));
      if (requestedScopes.length === 0 || requestedScopes.some(scope => !connectorScopes.has(scope))) {
        throw new Error('OAuth signed scope request is unavailable or no longer allowed');
      }
      const provider = this.createProvider({
        username,
        tenantId: connection.tenantId,
        server,
        record: consumed,
        oauth,
        allowRedirect: false,
      });
      const result = await this.authFn(provider, {
        serverUrl: server.config.url,
        authorizationCode: args.code,
        scope: requestedScopes.join(' '),
      });
      if (result !== 'AUTHORIZED') throw new Error('OAuth token exchange did not complete');
      if (consumed.userId && this.options.authorizeSubject
        && !await this.options.authorizeSubject(consumed.userId, consumed.tenantId)) {
        throw new Error('OAuth subject is not active');
      }
      if (!consumed.userId || !this.options.authorizeConnect
        || !await this.options.authorizeConnect(consumed.userId, consumed.tenantId, consumed.serverId)) {
        throw new Error('Connector assignment is unavailable');
      }
      const tokenScope = (await this.readBundle(username, consumed.tenantId, consumed.serverId)).tokens?.scope;
      const scopeSummary = typeof tokenScope === 'string'
        ? [...new Set(tokenScope.split(/\s+/).map(scope => scope.trim()).filter(Boolean))].sort()
        : [];
      if (scopeSummary.length === 0) throw new Error('OAuth granted scope evidence is unavailable');
      if (scopeSummary.some(scope => !requestedScopes.includes(scope))) {
        throw new Error('OAuth granted scope exceeds the signed request');
      }
      await this.markConnected(username, consumed, scopeSummary);
      return { ok: true, ...baseResult, scopeSummary };
    } catch (error) {
      const message = errorMessage(error);
      await this.markError(username, consumed, message);
      return { ok: false, ...baseResult, error: message };
    }
  }

  async disconnect(username: string, tenantId: string, serverId: string): Promise<void> {
    const record = this.options.store.getUserOAuthConnection(username, serverId);
    if (!record || record.tenantId !== tenantId) return;
    if (record.secretRef) {
      await this.options.vault.revokeSecret(record.secretRef, vaultCaller(username, tenantId, 'revoke'));
    }
    await this.options.store.deleteUserOAuthConnection(username, serverId);
  }

  async disconnectUser(username: string, tenantId: string): Promise<void> {
    await this.revokeUserConnections(username, tenantId);
    await this.options.store.removeUserData(username);
  }

  async revokeUserConnections(username: string, tenantId: string): Promise<void> {
    for (const record of this.options.store.listUserOAuthConnections(username)) {
      if (record.tenantId !== tenantId || !record.secretRef) continue;
      await this.options.vault.revokeSecret(record.secretRef, vaultCaller(username, tenantId, 'revoke'));
    }
  }

  async disconnectServerUsers(serverId: string): Promise<void> {
    for (const { username, connection } of this.options.store.listOAuthConnectionsForServer(serverId)) {
      if (connection.secretRef) {
        await this.options.vault.revokeSecret(connection.secretRef, vaultCaller(username, connection.tenantId, 'revoke'));
      }
      await this.options.store.deleteUserOAuthConnection(username, serverId);
    }
  }

  async runtimeProvider(args: {
    username: string;
    tenantId?: string;
    serverName: string;
  }): Promise<OAuthClientProvider | undefined> {
    if (!args.tenantId) return undefined;
    const server = this.options.store.getServer(args.serverName);
    const oauth = server ? oauthConfigOf(server) : undefined;
    const record = this.options.store.getUserOAuthConnection(args.username, args.serverName);
    if (!server || !oauth || !record?.secretRef || record.status !== 'connected' || !isHttpServer(server)) return undefined;
    const currentUser = this.options.userResolver?.(args.username);
    if (record.userId !== undefined && currentUser?.id !== record.userId) return undefined;
    if (record.userId && this.options.authorizeSubject
      && !await this.options.authorizeSubject(record.userId, args.tenantId)) return undefined;
    if (!record.userId || !this.options.authorizeGrant) return undefined;
    const grantId = `mcp:${args.tenantId}:${record.userId}:${server.id}`;
    if (!await this.options.authorizeGrant(grantId, record.userId, args.tenantId)) return undefined;
    if (!this.options.authorizeConnect
      || !await this.options.authorizeConnect(record.userId, args.tenantId, server.id)) return undefined;
    if (record.tenantId !== args.tenantId || !isServerVisibleToUser(server, args.username, args.tenantId)) return undefined;
    return this.createProvider({
      username: args.username,
      tenantId: args.tenantId,
      server,
      record,
      oauth,
      allowRedirect: false,
    });
  }

  async runtimeAccessToken(args: {
    username: string;
    tenantId: string;
    serverId: string;
  }): Promise<string | undefined> {
    const provider = await this.runtimeProvider({
      username: args.username,
      tenantId: args.tenantId,
      serverName: args.serverId,
    });
    const tokens = await provider?.tokens();
    return typeof tokens?.access_token === 'string' && tokens.access_token.trim()
      ? tokens.access_token
      : undefined;
  }

  clientMetadata(redirectUrl: string): OAuthClientMetadata & { client_id: string } {
    const clientId = clientMetadataUrl(redirectUrl);
    if (!clientId) throw new Error('OAuth Client ID Metadata Document requires an HTTPS callback URL');
    return {
      client_id: clientId,
      ...buildClientMetadata(redirectUrl, undefined),
    };
  }

  private createProvider(args: {
    username: string;
    tenantId: string;
    server: ManagedMcpServer & { config: Extract<ManagedMcpServer['config'], { type: 'http' | 'streamable-http' }> };
    record: McpOAuthConnectionRecord;
    oauth: McpOAuthServerConfig;
    allowRedirect: boolean;
  }): PersistentOAuthProvider {
    const staticClient = this.staticClient(args.oauth);
    return new PersistentOAuthProvider({
      redirectUrl: args.record.redirectUrl,
      clientMetadataUrl: staticClient ? undefined : clientMetadataUrl(args.record.redirectUrl),
      metadata: buildClientMetadata(args.record.redirectUrl, args.oauth, !!staticClient?.client_secret),
      state: args.record.pendingState ?? randomBytes(32).toString('base64url'),
      staticClient,
      allowRedirect: args.allowRedirect,
      onReconnectRequired: args.allowRedirect
        ? undefined
        : () => this.markError(args.username, args.record, 'OAuth authorization expired; reconnect this connector'),
      readBundle: () => this.readBundle(args.username, args.tenantId, args.server.id),
      updateBundle: mutate => this.updateBundle(args.username, args.tenantId, args.server.id, mutate),
    });
  }

  private isPlatformConfigured(oauth: McpOAuthServerConfig): boolean {
    if (!oauth.clientIdEnv && !oauth.clientSecretEnv) return true;
    return !!oauth.clientIdEnv && !!oauth.clientSecretEnv
      && !!this.env[oauth.clientIdEnv]?.trim()
      && !!this.env[oauth.clientSecretEnv]?.trim();
  }

  private assertPlatformConfigured(oauth: McpOAuthServerConfig): void {
    if (this.isPlatformConfigured(oauth)) return;
    throw new Error(`平台管理员需先配置 ${oauth.clientIdEnv ?? 'OAuth client ID'} 与 ${oauth.clientSecretEnv ?? 'OAuth client secret'}`);
  }

  private staticClient(oauth: McpOAuthServerConfig): OAuthClientInformationMixed | undefined {
    if (!oauth.clientIdEnv && !oauth.clientSecretEnv) return undefined;
    this.assertPlatformConfigured(oauth);
    return {
      client_id: this.env[oauth.clientIdEnv!]!.trim(),
      client_secret: this.env[oauth.clientSecretEnv!]!.trim(),
    };
  }

  private async readBundle(username: string, tenantId: string, serverId: string): Promise<OAuthBundle> {
    const record = this.options.store.getUserOAuthConnection(username, serverId);
    if (!record?.secretRef) return {};
    const raw = await this.options.vault.getSecret(record.secretRef, vaultCaller(username, tenantId, 'read'));
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid MCP OAuth secret bundle');
    return parsed as OAuthBundle;
  }

  private async updateBundle(
    username: string,
    tenantId: string,
    serverId: string,
    mutate: (bundle: OAuthBundle) => OAuthBundle,
  ): Promise<void> {
    await this.withConnectionLock(`${tenantId}:${username}:${serverId}`, async () => {
      const current = await this.readBundle(username, tenantId, serverId);
      const next = mutate(current);
      const record = this.options.store.getUserOAuthConnection(username, serverId);
      if (!record) throw new Error('MCP OAuth connection no longer exists');
      if (record.secretRef) {
        await this.options.vault.rotateSecret(record.secretRef, JSON.stringify(next), vaultCaller(username, tenantId, 'rotate'));
        await this.options.onSecretRotated?.(record.secretRef);
        return;
      }
      const ref = await this.options.vault.putSecret(
        username,
        OAUTH_SECRET_KIND,
        JSON.stringify(next),
        vaultCaller(username, tenantId, 'write'),
        { tenantId, username, serverId },
      );
      await this.options.store.setUserOAuthConnection(username, { ...record, secretRef: ref.id, updatedAt: new Date().toISOString() });
    });
  }

  private async markConnected(username: string, record: McpOAuthConnectionRecord, grantedScopes: string[]): Promise<void> {
    const latest = this.options.store.getUserOAuthConnection(username, record.serverId) ?? record;
    const now = new Date().toISOString();
    await this.options.store.setUserOAuthConnection(username, {
      ...latest,
      status: 'connected',
      pendingState: undefined,
      pendingExpiresAt: undefined,
      connectedAt: latest.connectedAt ?? now,
      grantedScopes,
      updatedAt: now,
      lastError: undefined,
    });
  }

  private async markError(username: string, record: McpOAuthConnectionRecord, error: string): Promise<void> {
    const latest = this.options.store.getUserOAuthConnection(username, record.serverId) ?? record;
    await this.options.store.setUserOAuthConnection(username, {
      ...latest,
      status: 'error',
      pendingState: undefined,
      pendingExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
      lastError: cleanError(error),
    });
  }

  private withConnectionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.connectionLocks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.connectionLocks.set(key, next);
    void next.then(() => {
      if (this.connectionLocks.get(key) === next) this.connectionLocks.delete(key);
    }, () => {
      if (this.connectionLocks.get(key) === next) this.connectionLocks.delete(key);
    });
    return next;
  }
}

class PersistentOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: string;
  readonly clientMetadataUrl?: string;

  constructor(private readonly options: {
    redirectUrl: string;
    clientMetadataUrl?: string;
    metadata: OAuthClientMetadata;
    state: string;
    staticClient?: OAuthClientInformationMixed;
    allowRedirect: boolean;
    onReconnectRequired?: () => Promise<void>;
    readBundle(): Promise<OAuthBundle>;
    updateBundle(mutate: (bundle: OAuthBundle) => OAuthBundle): Promise<void>;
  }) {
    this.clientMetadataUrl = options.clientMetadataUrl;
  }

  get redirectUrl(): string { return this.options.redirectUrl; }
  get clientMetadata(): OAuthClientMetadata { return this.options.metadata; }
  state(): string { return this.options.state; }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.options.staticClient ?? (await this.options.readBundle()).clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.options.updateBundle(bundle => ({ ...bundle, clientInformation }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.options.readBundle()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.options.updateBundle(bundle => ({ ...bundle, tokens }));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.options.allowRedirect) {
      await this.options.onReconnectRequired?.();
      throw new Error('OAuth authorization expired; reconnect this connector');
    }
    this.authorizationUrl = authorizationUrl.toString();
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.options.updateBundle(bundle => ({ ...bundle, codeVerifier }));
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.options.readBundle()).codeVerifier;
    if (!verifier) throw new Error('OAuth PKCE verifier is missing or expired');
    return verifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.options.updateBundle(bundle => ({ ...bundle, discoveryState }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.options.readBundle()).discoveryState;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    await this.options.updateBundle(bundle => {
      const next = { ...bundle };
      if (scope === 'all' || scope === 'client') delete next.clientInformation;
      if (scope === 'all' || scope === 'tokens') delete next.tokens;
      if (scope === 'all' || scope === 'verifier') delete next.codeVerifier;
      if (scope === 'all' || scope === 'discovery') delete next.discoveryState;
      return next;
    });
  }
}

function oauthConfigOf(server: ManagedMcpServer): McpOAuthServerConfig | undefined {
  if ('command' in server.config) return undefined;
  return server.config.oauth;
}

function isHttpServer(server: ManagedMcpServer): server is ManagedMcpServer & {
  config: Extract<ManagedMcpServer['config'], { type: 'http' | 'streamable-http' }>;
} {
  return !('command' in server.config);
}

function buildClientMetadata(
  redirectUrl: string,
  oauth?: McpOAuthServerConfig,
  hasClientSecret = false,
): OAuthClientMetadata {
  const origin = new URL(redirectUrl).origin;
  return {
    redirect_uris: [redirectUrl],
    token_endpoint_auth_method: hasClientSecret ? 'client_secret_basic' : 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: '开沿 AI 员工',
    client_uri: origin,
    software_id: 'net.kaiyan.agent-saas',
    software_version: '1.0.0',
    ...(oauth?.scopes?.length ? { scope: oauth.scopes.join(' ') } : {}),
  };
}

function clientMetadataUrl(redirectUrl: string): string | undefined {
  const url = new URL(redirectUrl);
  if (url.protocol !== 'https:') return undefined;
  return `${url.origin}/api/mcp/oauth/client-metadata`;
}

function sanitizeReturnTo(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const parsed = new URL(value, 'https://local.invalid');
    if (parsed.origin !== 'https://local.invalid') return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

function vaultCaller(username: string, tenantId: string, operation: VaultOperation): VaultCaller {
  return {
    actor: 'mcp_proxy',
    userId: username,
    tenantId,
    scopes: [`secret:${OAUTH_SECRET_KIND}:${operation}`],
  };
}

function errorMessage(error: unknown): string {
  return cleanError(error instanceof Error ? error.message : String(error));
}

function cleanError(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500) || 'OAuth authorization failed';
}
