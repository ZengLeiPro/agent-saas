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
// Testing/unverified Google OAuth apps reject consent requests above roughly 25 scopes.
// Keep this preset broad but executable; GCP and administrator scopes require a separate verified flow.
const GOOGLE_WORKSPACE_DEFAULT_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/chat.memberships',
  'https://www.googleapis.com/auth/chat.messages.reactions',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'https://www.googleapis.com/auth/meetings.space.settings',
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
] as const;

const GOOGLE_WORKSPACE_PREVIOUS_EXPANDED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.settings.sharing',
  'https://www.googleapis.com/auth/chat.spaces.pins',
  'https://www.googleapis.com/auth/chat.customemojis',
  'https://www.googleapis.com/auth/chat.users.readstate',
  'https://www.googleapis.com/auth/chat.users.availability',
  'https://www.googleapis.com/auth/chat.users.sections',
  'https://www.googleapis.com/auth/chat.users.spacesettings',
  'https://www.googleapis.com/auth/keep',
  'https://www.googleapis.com/auth/drive.meet.readonly',
  'https://www.googleapis.com/auth/script.processes',
  'https://www.googleapis.com/auth/script.metrics',
  'https://www.googleapis.com/auth/pubsub',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/admin.reports.audit.readonly',
  'https://www.googleapis.com/auth/admin.reports.usage.readonly',
  'https://www.googleapis.com/auth/chat.admin.spaces',
  'https://www.googleapis.com/auth/chat.admin.memberships',
  'https://www.googleapis.com/auth/chat.admin.delete',
  'https://www.googleapis.com/auth/classroom.courses',
  'https://www.googleapis.com/auth/classroom.rosters',
  'https://www.googleapis.com/auth/classroom.coursework.students',
  'https://www.googleapis.com/auth/classroom.coursework.me',
  'https://www.googleapis.com/auth/classroom.announcements',
  'https://www.googleapis.com/auth/classroom.topics',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials',
  'https://www.googleapis.com/auth/classroom.guardianlinks.students',
  'https://www.googleapis.com/auth/classroom.profile.emails',
  'https://www.googleapis.com/auth/classroom.profile.photos',
  'https://www.googleapis.com/auth/classroom.push-notifications',
] as const;

const GOOGLE_WORKSPACE_LEGACY_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly',
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
] as const;

export const GOOGLE_WORKSPACE_REQUESTED_SCOPES = [...GOOGLE_WORKSPACE_DEFAULT_SCOPES] as const;

const GOOGLE_WORKSPACE_ACCEPTED_SCOPES = new Set<string>([
  ...GOOGLE_WORKSPACE_REQUESTED_SCOPES,
  ...GOOGLE_WORKSPACE_PREVIOUS_EXPANDED_SCOPES,
  ...GOOGLE_WORKSPACE_LEGACY_SCOPES,
]);

const GOOGLE_WORKSPACE_SCOPE_ALIASES: Readonly<Record<string, string>> = {
  'https://www.googleapis.com/auth/userinfo.email': 'email',
  'https://www.googleapis.com/auth/userinfo.profile': 'profile',
};

const GOOGLE_WORKSPACE_SCOPE_UPGRADES: Readonly<Record<string, string>> = {
  'https://www.googleapis.com/auth/gmail.readonly': 'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.readonly': 'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar.readonly': 'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/chat.messages.readonly': 'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.spaces.readonly': 'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/contacts.readonly': 'https://www.googleapis.com/auth/contacts',
};

export interface GoogleWorkspaceOAuthUser {
  id: string;
  username: string;
  tenantId: string;
}

export interface GoogleWorkspaceAuthorizationResult {
  user: GoogleWorkspaceOAuthUser;
  scopeSummary: string[];
}

export interface GoogleWorkspacePendingOAuthState {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  requestedScopes: string[];
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
      if (current.expiresAt <= now || current.user.id === record.user.id) this.records.delete(state);
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
        requested_scopes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        user_id TEXT,
        user_json JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS user_id TEXT`);
    await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS requested_scopes_json JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_expires_idx ON ${this.table}(expires_at)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_user_idx ON ${this.table}(user_id)`);
    await this.pool.query(`
      DELETE FROM ${this.table} older
      USING ${this.table} newer
      WHERE older.user_id = newer.user_id
        AND older.user_id IS NOT NULL
        AND (older.created_at, older.state) < (newer.created_at, newer.state)
    `);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${this.table}_user_unique_idx ON ${this.table}(user_id) WHERE user_id IS NOT NULL`);
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
      INSERT INTO ${this.table} (state, code_verifier, redirect_uri, requested_scopes_json, user_id, user_json, expires_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
      ON CONFLICT (user_id) WHERE user_id IS NOT NULL DO UPDATE SET
        state = EXCLUDED.state,
        code_verifier = EXCLUDED.code_verifier,
        redirect_uri = EXCLUDED.redirect_uri,
        requested_scopes_json = EXCLUDED.requested_scopes_json,
        user_json = EXCLUDED.user_json,
        expires_at = EXCLUDED.expires_at,
        created_at = NOW()
    `, [
      record.state,
      record.codeVerifier,
      record.redirectUri,
      JSON.stringify(record.requestedScopes),
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
      requested_scopes_json: string[];
      user_json: GoogleWorkspaceOAuthUser;
      expires_at: Date | string;
    }>(`
      DELETE FROM ${this.table}
      WHERE state = $1 AND expires_at > NOW()
      RETURNING state, code_verifier, redirect_uri, requested_scopes_json, user_json, expires_at
    `, [state]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      state: row.state,
      codeVerifier: row.code_verifier,
      redirectUri: row.redirect_uri,
      requestedScopes: row.requested_scopes_json,
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
  runtimeEnabled: boolean;
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
  authorizeSubject?: (userId: string, tenantId: string) => Promise<boolean>;
  authorizeGrant?: (grantId: string, userId: string, tenantId: string) => Promise<boolean>;
  authorizeConnect?: (userId: string, tenantId: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  logger?: {
    warn(message: string): void;
  };
}

export class GoogleWorkspaceOAuthService {
  private readonly refreshes = new Map<string, Promise<string>>();
  private readonly authorizationCommits = new Map<string, Promise<void>>();
  private readonly fetchImpl: typeof fetch;
  private readonly stateStore: GoogleWorkspaceOAuthStateStore;

  constructor(private readonly options: GoogleWorkspaceOAuthServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.stateStore = options.stateStore ?? new InMemoryGoogleWorkspaceOAuthStateStore();
  }

  async startAuthorization(user: UserInfo, redirectUri: string): Promise<{
    authorizationUrl: string; state: string; requestedScopes: string[]; purpose: string;
    riskLevel: 'high'; dataDestination: string; revokeMethod: string;
  }> {
    await this.assertUserActive({ id: user.id, username: user.username, tenantId: user.tenantId });
    if (!this.options.authorizeConnect || !await this.options.authorizeConnect(user.id, user.tenantId)) {
      throw new Error('Google Workspace connector assignment is unavailable');
    }
    await this.stateStore.unblockUser(user.id);
    const previousScopes = await this.grantedScopes(user.id, user.username, user.tenantId).catch(() => []);
    const effectiveRequestedScopes = normalizeGoogleWorkspaceScopes([
      ...GOOGLE_WORKSPACE_REQUESTED_SCOPES,
      ...previousScopes,
    ]);
    const state = randomBytes(24).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    await this.stateStore.put({
      state,
      codeVerifier,
      redirectUri,
      requestedScopes: effectiveRequestedScopes,
      user: { id: user.id, username: user.username, tenantId: user.tenantId },
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    });

    const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_WORKSPACE_REQUESTED_SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    return {
      authorizationUrl: url.toString(), state,
      requestedScopes: effectiveRequestedScopes,
      purpose: '仅在本人获指派且组织已授权的 Agent Run 中调用 Google Workspace 内容、通信与自动化能力',
      riskLevel: 'high',
      dataDestination: '请求数据发送至 Google Workspace API；运行结果进入当前 Agent Run',
      revokeMethod: '可在连接与授权页经影响预览撤销；撤销后新 Run 立即不可用',
    };
  }

  async rejectAuthorization(state: string): Promise<boolean> {
    return Boolean(await this.stateStore.consume(state));
  }

  async finishAuthorization(input: {
    state: string;
    code: string;
    redirectUri: string;
    recordGrant?: (
      result: GoogleWorkspaceAuthorizationResult,
      previousScopes: string[],
    ) => Promise<(() => Promise<void>) | void>;
  }): Promise<GoogleWorkspaceAuthorizationResult> {
    const pending = await this.stateStore.consume(input.state);
    if (!pending) throw new Error('Google Workspace OAuth state 已过期');
    if (pending.redirectUri !== input.redirectUri) throw new Error('Google Workspace OAuth redirect_uri 不匹配');
    const commitKey = `${pending.user.tenantId}:${pending.user.id}`;
    const previousCommit = this.authorizationCommits.get(commitKey) ?? Promise.resolve();
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
    const queuedCommit = previousCommit.then(() => commitGate);
    this.authorizationCommits.set(commitKey, queuedCommit);
    await previousCommit;
    try {
    await this.assertUserActive(pending.user);
    if (!this.options.authorizeConnect || !await this.options.authorizeConnect(pending.user.id, pending.user.tenantId)) {
      throw new Error('Google Workspace connector assignment is unavailable');
    }
    const previousConnection = this.options.connectionStore.get(
      pending.user.username,
      GOOGLE_WORKSPACE_CONNECTOR_ID,
    );
    const ownedPreviousConnection = previousConnection?.status === 'connected'
      && previousConnection.userId === pending.user.id
      && previousConnection.tenantId === pending.user.tenantId
      ? previousConnection
      : undefined;
    const previousRuntimeEnabled = this.options.connectionStore.isRuntimeEnabled(
      pending.user.username,
      GOOGLE_WORKSPACE_CONNECTOR_ID,
    );
    const previousRef = ownedPreviousConnection?.credentialRefs[GOOGLE_WORKSPACE_OAUTH_CREDENTIAL_KEY];
    const previousBundle = previousRef
      ? await this.readBundle(
          previousRef,
          credentialOwnerId(ownedPreviousConnection),
          pending.user.tenantId,
        ).catch(() => undefined)
      : undefined;

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
    const exchangedBundle = tokenBundleFromResponse(tokenResponse);
    if (!response.ok || !exchangedBundle) {
      throw new Error(`Google Workspace token exchange failed: ${safeOAuthError(tokenResponse)}`);
    }
    if (!tokenResponse.scope?.trim()) throw new Error('Google Workspace granted scope evidence is unavailable');
    const scopeSummary = normalizeGoogleWorkspaceScopes(tokenResponse.scope.split(/\s+/));
    const grantedScopes = new Set(scopeSummary);
    const requestedScopes = new Set(normalizeGoogleWorkspaceScopes(pending.requestedScopes));
    if (requestedScopes.size === 0 || scopeSummary.some(scope => !requestedScopes.has(scope))) {
      throw new Error('Google Workspace granted scope exceeds the signed request');
    }
    const missingScopes = GOOGLE_WORKSPACE_REQUESTED_SCOPES.filter(scope => !grantedScopes.has(scope));
    if (missingScopes.length > 0) {
      throw new Error('Google Workspace did not grant every required scope');
    }
    const previousScopes = normalizeGrantedScopes(
      ownedPreviousConnection?.metadata?.grantedScopes ?? previousBundle?.scope,
    );
    if (previousScopes.some(scope => !googleScopeRemainsGranted(scope, grantedScopes))) {
      throw new Error('Google Workspace reauthorization would reduce existing access');
    }

    const metadata = await this.fetchAccountMetadata(exchangedBundle.accessToken);
    if (!metadata.accountId && !metadata.accountEmail) {
      throw new Error('Google Workspace account identity evidence is unavailable');
    }
    const needsPreviousRefreshToken = !tokenResponse.refresh_token && Boolean(previousBundle?.refreshToken);
    if (needsPreviousRefreshToken && !sameGoogleAccount(ownedPreviousConnection?.metadata, metadata)) {
      throw new Error('Google Workspace reauthorization account does not match the existing connection');
    }
    const bundle = tokenBundleFromResponse(tokenResponse, needsPreviousRefreshToken ? previousBundle : undefined);
    if (!bundle?.refreshToken) throw new Error('Google Workspace refresh token 不可用，请重新授权');
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
    const result = { user: pending.user, scopeSummary };
    let connected = false;
    let rollbackGrant: (() => Promise<void>) | undefined;
    try {
      await this.options.connectionStore.trackCredentialForRevocation({
        username: pending.user.username,
        connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
        credentialRef: ref.id,
        owner: { userId: pending.user.id, tenantId: pending.user.tenantId },
      });
      const grantCompensation = await input.recordGrant?.(result, previousScopes);
      rollbackGrant = typeof grantCompensation === 'function' ? grantCompensation : undefined;
      await this.assertUserActive(pending.user);
      await this.options.connectionStore.setRuntimeEnabled(
        pending.user.username,
        GOOGLE_WORKSPACE_CONNECTOR_ID,
        false,
      );
      await this.options.connectionStore.connect({
        username: pending.user.username,
        userId: pending.user.id,
        tenantId: pending.user.tenantId,
        connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
        credentialRefs: { [GOOGLE_WORKSPACE_OAUTH_CREDENTIAL_KEY]: ref.id },
        metadata: { ...metadata, credentialOwnerId: pending.user.id, grantedScopes: scopeSummary.join(' ') },
      });
      connected = true;
      await this.options.connectionStore.setRuntimeEnabled(
        pending.user.username,
        GOOGLE_WORKSPACE_CONNECTOR_ID,
        true,
      );
      await this.revokePending(pending.user.username);
      return result;
    } catch (error) {
      if (!connected) {
        await this.options.connectionStore.setRuntimeEnabled(
          pending.user.username,
          GOOGLE_WORKSPACE_CONNECTOR_ID,
          previousRuntimeEnabled,
        ).catch(() => undefined);
        await rollbackGrant?.().catch(rollbackError => {
          this.options.logger?.warn(`Google Workspace Grant compensation failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        });
        try {
          await this.options.vault.revokeSecret(
            ref.id,
            vaultCaller(pending.user.id, pending.user.tenantId, 'revoke'),
          );
          await this.options.connectionStore.markCredentialRevoked(
            pending.user.username,
            GOOGLE_WORKSPACE_CONNECTOR_ID,
            ref.id,
          );
        } catch (revokeError) {
          this.options.logger?.warn(`Google Workspace credential compensation failed: ${revokeError instanceof Error ? revokeError.message : String(revokeError)}`);
        }
      }
      throw error;
    }
    } finally {
      releaseCommit();
      if (this.authorizationCommits.get(commitKey) === queuedCommit) {
        this.authorizationCommits.delete(commitKey);
      }
    }
  }

  async grantedScopes(userId: string, username: string, tenantId: string): Promise<string[]> {
    const record = this.options.connectionStore.get(username, GOOGLE_WORKSPACE_CONNECTOR_ID);
    if (!record || record.status !== 'connected' || record.userId !== userId || record.tenantId !== tenantId) return [];
    const metadataScopes = normalizeGrantedScopes(record.metadata?.grantedScopes);
    if (metadataScopes.length > 0) return metadataScopes;
    const ref = record.credentialRefs[GOOGLE_WORKSPACE_OAUTH_CREDENTIAL_KEY];
    if (!ref) return [];
    const bundle = await this.readBundle(ref, credentialOwnerId(record), tenantId);
    return normalizeGrantedScopes(bundle.scope);
  }

  connectionView(userId: string, username: string, tenantId: string): GoogleWorkspaceConnectionView {
    const record = this.options.connectionStore.get(username, GOOGLE_WORKSPACE_CONNECTOR_ID);
    const connected = record?.status === 'connected'
      && record.userId === userId
      && record.tenantId === tenantId;
    const runtimeEnabled = this.options.connectionStore.isRuntimeEnabled(username, GOOGLE_WORKSPACE_CONNECTOR_ID);
    return {
      connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
      status: connected ? 'connected' : 'disconnected',
      runtimeEnabled,
      accountEmail: connected ? record?.metadata?.accountEmail : undefined,
      connectedAt: connected ? record?.connectedAt : undefined,
      updatedAt: record?.updatedAt,
      cliCommand: 'gws',
      envAvailable: connected && runtimeEnabled,
    };
  }

  async accessToken(userId: string, username: string, tenantId: string): Promise<string | undefined> {
    const record = this.options.connectionStore.get(username, GOOGLE_WORKSPACE_CONNECTOR_ID);
    if (!record || record.status !== 'connected' || record.userId !== userId || record.tenantId !== tenantId) return undefined;
    if (!this.options.connectionStore.isRuntimeEnabled(username, GOOGLE_WORKSPACE_CONNECTOR_ID)) return undefined;
    if (this.options.authorizeSubject && !await this.options.authorizeSubject(userId, tenantId)) return undefined;
    const grantId = `google-workspace:${tenantId}:${userId}`;
    if (!this.options.authorizeGrant || !await this.options.authorizeGrant(grantId, userId, tenantId)) return undefined;
    if (!this.options.authorizeConnect || !await this.options.authorizeConnect(userId, tenantId)) return undefined;
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
    const refreshed = tokenBundleFromResponse(tokenResponse, current);
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
    if (this.options.authorizeSubject
      && !await this.options.authorizeSubject(user.id, user.tenantId)) {
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
        const owner = record.pendingRevokeRefOwners?.[ref];
        await this.options.vault.revokeSecret(ref, vaultCaller(
          owner?.userId ?? credentialOwnerId(record),
          owner?.tenantId ?? record.tenantId,
          'revoke',
        ));
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
  fallback?: Pick<GoogleTokenBundle, 'refreshToken' | 'scope' | 'tokenType'>,
): GoogleTokenBundle | undefined {
  if (!response.access_token) return undefined;
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? fallback?.refreshToken,
    expiresAt: Date.now() + Math.max(1, response.expires_in ?? 3600) * 1_000,
    scope: response.scope ?? fallback?.scope,
    tokenType: response.token_type ?? fallback?.tokenType,
  };
}

function safeOAuthError(response: GoogleTokenResponse): string {
  return (response.error_description || response.error || 'unknown error').slice(0, 300);
}

function normalizeGrantedScopes(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const scopes = normalizeGoogleWorkspaceScopes(value.split(/\s+/));
  return scopes.every(scope => GOOGLE_WORKSPACE_ACCEPTED_SCOPES.has(scope)) ? scopes : [];
}

function normalizeGoogleWorkspaceScopes(scopes: Iterable<string>): string[] {
  return [...new Set([...scopes]
    .map(scope => scope.trim())
    .filter(Boolean)
    .map(scope => GOOGLE_WORKSPACE_SCOPE_ALIASES[scope] ?? scope))].sort();
}

function googleScopeRemainsGranted(scope: string, grantedScopes: Set<string>): boolean {
  return grantedScopes.has(scope) || grantedScopes.has(GOOGLE_WORKSPACE_SCOPE_UPGRADES[scope] ?? '');
}

function sameGoogleAccount(
  previous: Record<string, string> | undefined,
  current: Record<string, string>,
): boolean {
  if (previous?.accountId && current.accountId) return previous.accountId === current.accountId;
  if (previous?.accountEmail && current.accountEmail) {
    return previous.accountEmail.toLowerCase() === current.accountEmail.toLowerCase();
  }
  return false;
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
