import { createHash, randomBytes } from 'node:crypto';
import type { Pool as PgPool } from 'pg';

import type { UserInfo } from '../data/users/types.js';
import type { SecretVault, VaultOperation } from '../security/secretVault.js';
import type { ConnectorConnectionRecord, ConnectorConnectionStore } from './connectionStore.js';

export const GOOGLE_WORKSPACE_CONNECTOR_ID = 'google-workspace';
export const GOOGLE_WORKSPACE_OAUTH_CREDENTIAL_KEY = 'oauth';

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60 * 1_000;
const GOOGLE_WORKSPACE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/contacts',
];

export interface GoogleWorkspaceOAuthUser {
  id: string;
  username: string;
  tenantId: string;
}

export interface GoogleWorkspacePendingOAuthState {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  user: GoogleWorkspaceOAuthUser;
  expiresAt: number;
}

export interface GoogleWorkspaceOAuthStateStore {
  put(record: GoogleWorkspacePendingOAuthState): Promise<void>;
  consume(state: string): Promise<GoogleWorkspacePendingOAuthState | undefined>;
  blockUser(userId: string): Promise<void>;
  unblockUser(userId: string): Promise<void>;
  isUserBlocked(userId: string): Promise<boolean>;
}

export class InMemoryGoogleWorkspaceOAuthStateStore implements GoogleWorkspaceOAuthStateStore {
  private readonly records = new Map<string, GoogleWorkspacePendingOAuthState>();
  private readonly blockedUsers = new Set<string>();

  async put(record: GoogleWorkspacePendingOAuthState): Promise<void> {
    const now = Date.now();
    for (const [state, current] of this.records) {
      if (current.expiresAt <= now) this.records.delete(state);
    }
    this.records.set(record.state, record);
  }

  async consume(state: string): Promise<GoogleWorkspacePendingOAuthState | undefined> {
    const record = this.records.get(state);
    this.records.delete(state);
    return record?.expiresAt && record.expiresAt > Date.now() ? record : undefined;
  }

  async blockUser(userId: string): Promise<void> {
    this.blockedUsers.add(userId);
    for (const [state, record] of this.records) {
      if (record.user.id === userId) this.records.delete(state);
    }
  }

  async unblockUser(userId: string): Promise<void> {
    this.blockedUsers.delete(userId);
  }

  async isUserBlocked(userId: string): Promise<boolean> {
    return this.blockedUsers.has(userId);
  }
}

export class PgGoogleWorkspaceOAuthStateStore implements GoogleWorkspaceOAuthStateStore {
  private readonly table: string;
  private readonly blockedUsersTable: string;

  constructor(private readonly pool: PgPool, tablePrefix = 'runtime') {
    const prefix = sanitizeIdentifier(tablePrefix);
    this.table = `${prefix}_google_workspace_oauth_states`;
    this.blockedUsersTable = `${prefix}_google_workspace_oauth_blocked_users`;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        state TEXT PRIMARY KEY,
        code_verifier TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        user_id TEXT,
        user_json JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS user_id TEXT`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_expires_idx ON ${this.table}(expires_at)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_user_idx ON ${this.table}(user_id)`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.blockedUsersTable} (
        user_id TEXT PRIMARY KEY,
        blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async put(record: GoogleWorkspacePendingOAuthState): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.table} WHERE expires_at <= NOW()`);
    await this.pool.query(`
      INSERT INTO ${this.table} (state, code_verifier, redirect_uri, user_id, user_json, expires_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (state) DO UPDATE SET
        code_verifier = EXCLUDED.code_verifier,
        redirect_uri = EXCLUDED.redirect_uri,
        user_id = EXCLUDED.user_id,
        user_json = EXCLUDED.user_json,
        expires_at = EXCLUDED.expires_at
    `, [
      record.state,
      record.codeVerifier,
      record.redirectUri,
      record.user.id,
      JSON.stringify(record.user),
      new Date(record.expiresAt),
    ]);
  }

  async consume(state: string): Promise<GoogleWorkspacePendingOAuthState | undefined> {
    const result = await this.pool.query<{
      state: string;
      code_verifier: string;
      redirect_uri: string;
      user_json: GoogleWorkspaceOAuthUser;
      expires_at: Date | string;
    }>(`
      DELETE FROM ${this.table}
      WHERE state = $1 AND expires_at > NOW()
      RETURNING state, code_verifier, redirect_uri, user_json, expires_at
    `, [state]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      state: row.state,
      codeVerifier: row.code_verifier,
      redirectUri: row.redirect_uri,
      user: row.user_json,
      expiresAt: new Date(row.expires_at).getTime(),
    };
  }

  async blockUser(userId: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO ${this.blockedUsersTable} (user_id) VALUES ($1)
      ON CONFLICT (user_id) DO UPDATE SET blocked_at = NOW()
    `, [userId]);
    await this.pool.query(`DELETE FROM ${this.table} WHERE user_id = $1`, [userId]);
  }

  async unblockUser(userId: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.blockedUsersTable} WHERE user_id = $1`, [userId]);
  }

  async isUserBlocked(userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM ${this.blockedUsersTable} WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    return result.rowCount === 1;
  }
}

interface GoogleTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  tokenType?: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface GoogleWorkspaceConnectionView {
  connectorId: typeof GOOGLE_WORKSPACE_CONNECTOR_ID;
  status: 'connected' | 'disconnected';
  accountEmail?: string;
  connectedAt?: string;
  updatedAt?: string;
  cliCommand: 'gws';
  envAvailable: boolean;
}

export interface GoogleWorkspaceOAuthServiceOptions {
  clientId: string;
  clientSecret: string;
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
  stateStore?: GoogleWorkspaceOAuthStateStore;
  userResolver?: (userId: string) => UserInfo | undefined;
  fetchImpl?: typeof fetch;
  logger?: {
    warn(message: string): void;
  };
}

export class GoogleWorkspaceOAuthService {
  private readonly refreshes = new Map<string, Promise<string>>();
  private readonly fetchImpl: typeof fetch;
  private readonly stateStore: GoogleWorkspaceOAuthStateStore;

  constructor(private readonly options: GoogleWorkspaceOAuthServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.stateStore = options.stateStore ?? new InMemoryGoogleWorkspaceOAuthStateStore();
  }

  async startAuthorization(user: UserInfo, redirectUri: string): Promise<{ authorizationUrl: string; state: string }> {
    await this.stateStore.unblockUser(user.id);
    const state = randomBytes(24).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    await this.stateStore.put({
      state,
      codeVerifier,
      redirectUri,
      user: { id: user.id, username: user.username, tenantId: user.tenantId },
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    });

    const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_WORKSPACE_SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    return { authorizationUrl: url.toString(), state };
  }

  async finishAuthorization(input: { state: string; code: string; redirectUri: string }): Promise<{ user: GoogleWorkspaceOAuthUser }> {
    const pending = await this.stateStore.consume(input.state);
    if (!pending) throw new Error('Google Workspace OAuth state 已过期');
    if (pending.redirectUri !== input.redirectUri) throw new Error('Google Workspace OAuth redirect_uri 不匹配');
    await this.assertUserActive(pending.user);

    const response = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code: input.code,
        code_verifier: pending.codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: input.redirectUri,
      }),
    });
    const tokenResponse = await response.json() as GoogleTokenResponse;
    const bundle = tokenBundleFromResponse(tokenResponse);
    if (!response.ok || !bundle) {
      throw new Error(`Google Workspace token exchange failed: ${safeOAuthError(tokenResponse)}`);
    }

    const metadata = await this.fetchAccountMetadata(bundle.accessToken);
    await this.assertUserActive(pending.user);
    const ref = await this.options.vault.putSecret(
      pending.user.id,
      'connector',
      JSON.stringify(bundle),
      vaultCaller(pending.user.id, pending.user.tenantId, 'write'),
      {
        ownerId: pending.user.id,
        tenantId: pending.user.tenantId,
        connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
      },
    );
    let connected = false;
    try {
      await this.options.connectionStore.connect({
        username: pending.user.username,
        userId: pending.user.id,
        tenantId: pending.user.tenantId,
        connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
        credentialRefs: { [GOOGLE_WORKSPACE_OAUTH_CREDENTIAL_KEY]: ref.id },
        metadata: { ...metadata, credentialOwnerId: pending.user.id },
      });
      connected = true;
      await this.assertUserActive(pending.user);
      await this.revokePending(pending.user.username);
      return { user: pending.user };
    } catch (error) {
      if (connected) {
        await this.options.connectionStore.disconnect(
          pending.user.username,
          GOOGLE_WORKSPACE_CONNECTOR_ID,
          pending.user.tenantId,
        ).catch(() => undefined);
      }
      await this.options.vault.revokeSecret(
        ref.id,
        vaultCaller(pending.user.id, pending.user.tenantId, 'revoke'),
      ).catch(() => undefined);
      if (connected) await this.revokePending(pending.user.username);
      throw error;
    }
  }

  connectionView(userId: string, username: string, tenantId: string): GoogleWorkspaceConnectionView {
    const record = this.options.connectionStore.get(username, GOOGLE_WORKSPACE_CONNECTOR_ID);
    const connected = record?.status === 'connected'
      && record.userId === userId
      && record.tenantId === tenantId;
    return {
      connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
      status: connected ? 'connected' : 'disconnected',
      accountEmail: connected ? record?.metadata?.accountEmail : undefined,
      connectedAt: connected ? record?.connectedAt : undefined,
      updatedAt: record?.updatedAt,
      cliCommand: 'gws',
      envAvailable: connected,
    };
  }

  async accessToken(userId: string, username: string, tenantId: string): Promise<string | undefined> {
    const record = this.options.connectionStore.get(username, GOOGLE_WORKSPACE_CONNECTOR_ID);
    if (!record || record.status !== 'connected' || record.userId !== userId || record.tenantId !== tenantId) return undefined;
    const ref = record.credentialRefs[GOOGLE_WORKSPACE_OAUTH_CREDENTIAL_KEY];
    if (!ref) return undefined;
    const ownerId = credentialOwnerId(record);
    const bundle = await this.readBundle(ref, ownerId, tenantId);
    if (bundle.expiresAt > Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS) return bundle.accessToken;
    if (!bundle.refreshToken) throw new Error('Google Workspace refresh token 不可用，请重新授权');

    const key = `${tenantId}:${userId}`;
    const existing = this.refreshes.get(key);
    if (existing) return await existing;
    const refreshing = this.refreshAccessToken(ref, ownerId, tenantId, bundle)
      .finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, refreshing);
    return await refreshing;
  }

  async cancelUser(userId: string): Promise<void> {
    await this.stateStore.blockUser(userId);
  }

  async disconnect(userId: string, username: string, tenantId: string): Promise<void> {
    const record = this.options.connectionStore.get(username, GOOGLE_WORKSPACE_CONNECTOR_ID);
    if (!record || record.userId !== userId || record.tenantId !== tenantId) return;
    const ref = record.credentialRefs[GOOGLE_WORKSPACE_OAUTH_CREDENTIAL_KEY];
    if (ref) {
      const bundle = await this.readBundle(ref, credentialOwnerId(record), tenantId);
      const token = bundle.refreshToken || bundle.accessToken;
      const response = await this.fetchImpl('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
      if (!response.ok && response.status !== 400) {
        throw new Error(`Google Workspace provider revoke failed: HTTP ${response.status}`);
      }
    }
    await this.options.connectionStore.disconnect(username, GOOGLE_WORKSPACE_CONNECTOR_ID, tenantId);
    await this.revokePending(username);
  }

  private async refreshAccessToken(
    ref: string,
    ownerId: string,
    tenantId: string,
    current: GoogleTokenBundle,
  ): Promise<string> {
    const response = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        refresh_token: current.refreshToken!,
        grant_type: 'refresh_token',
      }),
    });
    const tokenResponse = await response.json() as GoogleTokenResponse;
    const refreshed = tokenBundleFromResponse(tokenResponse, current.refreshToken);
    if (!response.ok || !refreshed) {
      throw new Error(`Google Workspace token refresh failed: ${safeOAuthError(tokenResponse)}`);
    }
    await this.options.vault.rotateSecret(ref, JSON.stringify(refreshed), vaultCaller(ownerId, tenantId, 'rotate'));
    return refreshed.accessToken;
  }

  private async readBundle(ref: string, ownerId: string, tenantId: string): Promise<GoogleTokenBundle> {
    const raw = await this.options.vault.getSecret(ref, vaultCaller(ownerId, tenantId, 'read'));
    const parsed = JSON.parse(raw) as Partial<GoogleTokenBundle>;
    if (!parsed.accessToken || typeof parsed.expiresAt !== 'number') {
      throw new Error('Google Workspace OAuth credential 格式无效');
    }
    return parsed as GoogleTokenBundle;
  }

  private async assertUserActive(user: GoogleWorkspaceOAuthUser): Promise<void> {
    if (await this.stateStore.isUserBlocked(user.id)) {
      throw new Error('Google Workspace 授权用户已失效');
    }
    const currentUser = this.options.userResolver?.(user.id);
    if (this.options.userResolver && (
      !currentUser
      || currentUser.disabled
      || currentUser.username !== user.username
      || currentUser.tenantId !== user.tenantId
    )) {
      throw new Error('Google Workspace 授权用户已失效');
    }
  }

  private async fetchAccountMetadata(accessToken: string): Promise<Record<string, string>> {
    try {
      const response = await this.fetchImpl(GOOGLE_USERINFO_ENDPOINT, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return {};
      const data = await response.json() as { email?: string; name?: string; sub?: string };
      return {
        ...(data.email ? { accountEmail: data.email } : {}),
        ...(data.name ? { accountName: data.name } : {}),
        ...(data.sub ? { accountId: data.sub } : {}),
      };
    } catch {
      return {};
    }
  }

  private async revokePending(username: string): Promise<void> {
    const record = this.options.connectionStore.get(username, GOOGLE_WORKSPACE_CONNECTOR_ID);
    if (!record) return;
    for (const ref of record.pendingRevokeRefs ?? []) {
      try {
        await this.options.vault.revokeSecret(ref, vaultCaller(credentialOwnerId(record), record.tenantId, 'revoke'));
        await this.options.connectionStore.markCredentialRevoked(
          record.username,
          GOOGLE_WORKSPACE_CONNECTOR_ID,
          ref,
        );
      } catch (error) {
        this.options.logger?.warn(`Google Workspace credential revoke failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

export async function resolveGoogleWorkspaceRuntimeEnv(
  service: GoogleWorkspaceOAuthService | undefined,
  context: { userId: string; username: string; tenantId: string },
  onError?: (error: Error) => void,
): Promise<Record<string, string>> {
  if (!service) return {};
  try {
    const token = await service.accessToken(context.userId, context.username, context.tenantId);
    return token ? { GOOGLE_WORKSPACE_CLI_TOKEN: token } : {};
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
    return {};
  }
}

function tokenBundleFromResponse(
  response: GoogleTokenResponse,
  fallbackRefreshToken?: string,
): GoogleTokenBundle | undefined {
  if (!response.access_token) return undefined;
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? fallbackRefreshToken,
    expiresAt: Date.now() + Math.max(1, response.expires_in ?? 3600) * 1_000,
    scope: response.scope,
    tokenType: response.token_type,
  };
}

function safeOAuthError(response: GoogleTokenResponse): string {
  return (response.error_description || response.error || 'unknown error').slice(0, 300);
}

function sanitizeIdentifier(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]/g, '_');
  if (!normalized || !/^[a-zA-Z_]/.test(normalized)) throw new Error('Invalid Google OAuth table prefix');
  return normalized;
}

function credentialOwnerId(record: ConnectorConnectionRecord): string {
  const ownerId = record.metadata?.credentialOwnerId;
  return typeof ownerId === 'string' && ownerId.length > 0 ? ownerId : record.username;
}

function vaultCaller(ownerId: string, tenantId: string, operation: VaultOperation) {
  return {
    actor: 'connector_proxy' as const,
    userId: ownerId,
    tenantId,
    scopes: [`secret:connector:${operation}`],
  };
}
