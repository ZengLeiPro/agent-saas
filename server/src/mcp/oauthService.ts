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
import type { SecretVault, VaultCaller } from '../security/secretVault.js';

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
}

export interface McpOAuthFinishResult {
  ok: boolean;
  username: string;
  serverId: string;
  tenantId: string;
  redirectUrl: string;
  returnTo: string;
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
  userResolver?: (username: string) => { tenantId: string; disabled?: boolean } | undefined;
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
    tenantId: string;
    server: ManagedMcpServer;
    redirectUrl: string;
    returnTo: string;
  }): Promise<McpOAuthStartResult> {
    const { username, tenantId, server } = args;
    if (!isServerVisibleToUser(server, username, tenantId)) throw new Error('MCP server not found');
    const oauth = oauthConfigOf(server);
    if (!oauth || !isHttpServer(server)) throw new Error('This MCP server does not support OAuth');
    assertSafeMcpUrl(server.config.url);
    this.assertPlatformConfigured(oauth);

    const previous = this.options.store.getUserOAuthConnection(username, server.id);
    if (previous?.status === 'connected' && previous.secretRef) return { status: 'connected' };

    const now = new Date();
    const state = randomBytes(32).toString('base64url');
    const record: McpOAuthConnectionRecord = {
      serverId: server.id,
      tenantId,
      status: 'pending',
      secretRef: previous?.secretRef,
      pendingState: state,
      pendingExpiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
      redirectUrl: args.redirectUrl,
      returnTo: sanitizeReturnTo(args.returnTo),
      updatedAt: now.toISOString(),
    };
    await this.options.store.setUserOAuthConnection(username, record);

    const provider = this.createProvider({ username, tenantId, server, record, oauth, allowRedirect: true });
    try {
      const result = await this.authFn(provider, {
        serverUrl: server.config.url,
        ...(oauth.scopes?.length ? { scope: oauth.scopes.join(' ') } : {}),
      });
      if (result === 'AUTHORIZED') {
        await this.markConnected(username, record);
        return { status: 'connected' };
      }
      const authorizationUrl = provider.authorizationUrl;
      if (!authorizationUrl) throw new Error('OAuth provider did not return an authorization URL');
      return { status: 'pending', authorizationUrl };
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
    if (this.options.userResolver && (!user || user.disabled || user.tenantId !== connection.tenantId)) {
      const message = 'User or tenant changed during OAuth authorization';
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
        ...(oauth.scopes?.length ? { scope: oauth.scopes.join(' ') } : {}),
      });
      if (result !== 'AUTHORIZED') throw new Error('OAuth token exchange did not complete');
      await this.markConnected(username, consumed);
      return { ok: true, ...baseResult };
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
      await this.options.vault.revokeSecret(record.secretRef, vaultCaller(username, tenantId));
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
      await this.options.vault.revokeSecret(record.secretRef, vaultCaller(username, tenantId));
    }
  }

  async disconnectServerUsers(serverId: string): Promise<void> {
    for (const { username, connection } of this.options.store.listOAuthConnectionsForServer(serverId)) {
      if (connection.secretRef) {
        await this.options.vault.revokeSecret(connection.secretRef, vaultCaller(username, connection.tenantId));
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

  clientMetadata(redirectUrl: string): OAuthClientMetadata {
    return buildClientMetadata(redirectUrl, undefined);
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
    const raw = await this.options.vault.getSecret(record.secretRef, vaultCaller(username, tenantId));
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
        await this.options.vault.rotateSecret(record.secretRef, JSON.stringify(next), vaultCaller(username, tenantId));
        return;
      }
      const ref = await this.options.vault.putSecret(username, OAUTH_SECRET_KIND, JSON.stringify(next), {
        tenantId,
        username,
        serverId,
      });
      await this.options.store.setUserOAuthConnection(username, { ...record, secretRef: ref.id, updatedAt: new Date().toISOString() });
    });
  }

  private async markConnected(username: string, record: McpOAuthConnectionRecord): Promise<void> {
    const latest = this.options.store.getUserOAuthConnection(username, record.serverId) ?? record;
    const now = new Date().toISOString();
    await this.options.store.setUserOAuthConnection(username, {
      ...latest,
      status: 'connected',
      pendingState: undefined,
      pendingExpiresAt: undefined,
      connectedAt: latest.connectedAt ?? now,
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

function vaultCaller(username: string, tenantId: string): VaultCaller {
  return {
    actor: 'mcp_proxy',
    userId: username,
    tenantId,
    scopes: [`secret:${OAUTH_SECRET_KIND}:read`],
  };
}

function errorMessage(error: unknown): string {
  return cleanError(error instanceof Error ? error.message : String(error));
}

function cleanError(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500) || 'OAuth authorization failed';
}
