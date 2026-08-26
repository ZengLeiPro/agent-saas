import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AppConfig } from '../app/config.js';
import { isStagingServerEgressSafe } from '../runtime/egressPolicy.js';
import { readRuntimeIdentity, type RuntimeIdentity } from './runtimeIdentity.js';

export interface RuntimeEnvironmentSafetyOptions {
  processCwd?: string;
}

function values(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(values);
  if (value && typeof value === 'object') return Object.values(value).flatMap(values);
  return [];
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function allowedHosts(envValue: string | undefined): Set<string> {
  return new Set(
    (envValue ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function urlAllowed(value: string | undefined, allowlist: Set<string>): boolean {
  if (!value || allowlist.size === 0) return false;
  try {
    return allowlist.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function credentialRefInNamespace(value: string | undefined, namespace: string): boolean {
  return Boolean(
    value &&
    (value === namespace || value.startsWith(`${namespace}/`) || value.startsWith(`${namespace}_`)),
  );
}

function isWithinRoot(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
  try {
    const pathFromRoot = relative(realpathSync(root), realpathSync(candidate));
    return (
      pathFromRoot === '' ||
      (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
    );
  } catch {
    return false;
  }
}

/**
 * Staging is a separate safety domain, not NODE_ENV=staging. This pure startup
 * assertion fails closed before any service, scheduler, or connector starts.
 */
export function assertRuntimeEnvironmentSafety(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: RuntimeEnvironmentSafetyOptions = {},
): RuntimeIdentity {
  const identity = readRuntimeIdentity(env);
  if (identity.environment !== 'staging') return { ...identity, safetyAttested: true };

  const failures: string[] = [];
  if (config.cron?.enabled !== false)
    failures.push('staging cron.enabled must be explicitly false');
  const allowedAcsHosts = new Set(
    (env.AGENT_SAAS_STAGING_ACS_HOSTS ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const hand of config.tenantRemoteHands?.hands ?? []) {
    const handUrl = parseUrl(hand.baseUrl);
    if (
      !handUrl ||
      allowedAcsHosts.size === 0 ||
      !allowedAcsHosts.has(handUrl.hostname.toLowerCase())
    ) {
      failures.push(`staging Hand ${hand.id} is not bound to an allowed Staging ACS host`);
    }
  }

  const stagingRoot = env.AGENT_SAAS_STAGING_ROOT?.trim();
  if (!stagingRoot || !isAbsolute(stagingRoot))
    failures.push('AGENT_SAAS_STAGING_ROOT must be an absolute path');
  if (stagingRoot && !isWithinRoot(stagingRoot, config.agent.cwd ?? '')) {
    failures.push('agent workspace must be an absolute path within AGENT_SAAS_STAGING_ROOT');
  }
  const processCwd = options.processCwd ?? process.cwd();
  if (!processCwd || !stagingRoot || !isWithinRoot(stagingRoot, processCwd)) {
    failures.push('server processCwd/data must be pre-created within AGENT_SAAS_STAGING_ROOT');
  } else if (!isWithinRoot(stagingRoot, resolve(processCwd, 'data'))) {
    failures.push('server-data must be within AGENT_SAAS_STAGING_ROOT');
  }
  const agentCwd = config.agent.cwd ?? '';
  if (stagingRoot && !isWithinRoot(stagingRoot, resolve(agentCwd, 'uploads'))) {
    failures.push('uploads must be within AGENT_SAAS_STAGING_ROOT');
  }
  const sharedDir = config.agent.sharedDir
    ? resolve(processCwd ? resolve(processCwd, '..') : '', config.agent.sharedDir)
    : resolve(agentCwd, '.shared');
  if (stagingRoot && !isWithinRoot(stagingRoot, sharedDir))
    failures.push('agent sharedDir/NAS must be within AGENT_SAAS_STAGING_ROOT');
  if (
    stagingRoot &&
    config.secretVault?.backend === 'encrypted-file' &&
    !isWithinRoot(stagingRoot, config.secretVault.filePath)
  ) {
    failures.push('SecretVault file must be an absolute path within AGENT_SAAS_STAGING_ROOT');
  }
  if (!config.secretVault || config.secretVault.backend === 'memory') {
    failures.push('staging requires an isolated persistent SecretVault');
  }
  const vaultHosts = allowedHosts(env.AGENT_SAAS_STAGING_SECRET_VAULT_HOSTS);
  if (config.secretVault?.backend === 'http' && !urlAllowed(config.secretVault.baseUrl, vaultHosts))
    failures.push('HTTP SecretVault host is not staging-allowlisted');

  const credentialNamespace = env.AGENT_SAAS_STAGING_CREDENTIAL_NAMESPACE?.trim() ?? '';
  const productionCredentialNamespace =
    env.AGENT_SAAS_PRODUCTION_CREDENTIAL_NAMESPACE?.trim() ?? '';
  if (
    !credentialNamespace ||
    !productionCredentialNamespace ||
    credentialNamespace === productionCredentialNamespace
  ) {
    failures.push('staging and production credential namespaces must be explicit and distinct');
  }
  if (
    config.secretVault?.backend === 'encrypted-file' &&
    !credentialRefInNamespace(config.secretVault.encryptionKeyEnv, credentialNamespace)
  ) {
    failures.push('SecretVault encryption key env must belong to the staging credential namespace');
  }
  if (
    config.secretVault?.backend === 'http' &&
    !credentialRefInNamespace(config.secretVault.authTokenEnv, credentialNamespace)
  ) {
    failures.push('SecretVault auth token env must belong to the staging credential namespace');
  }
  if (!config.auth?.enabled || !config.auth.jwtSecret) {
    failures.push('staging authentication and its JWT secret must be explicitly enabled');
  } else {
    const stagingJwtFingerprint = env.AGENT_SAAS_STAGING_JWT_SECRET_SHA256?.trim();
    const productionJwtFingerprint = env.AGENT_SAAS_PRODUCTION_JWT_SECRET_SHA256?.trim();
    if (
      !stagingJwtFingerprint ||
      !productionJwtFingerprint ||
      stagingJwtFingerprint !== digest(config.auth.jwtSecret) ||
      stagingJwtFingerprint === productionJwtFingerprint
    ) {
      failures.push('staging JWT fingerprint must match config and differ from production');
    }
  }

  const handHosts = allowedHosts(env.AGENT_SAAS_STAGING_HAND_HOSTS);
  if (config.serverRemote && !urlAllowed(config.serverRemote.baseUrl, handHosts))
    failures.push('serverRemote host is not staging-allowlisted');
  const remoteHands = [
    ...(config.serverRemote ? [{ label: 'serverRemote', remote: config.serverRemote }] : []),
    ...(config.tenantRemoteHands?.hands ?? []).map((hand) => ({
      label: `Hand ${hand.id}`,
      remote: hand,
    })),
  ];
  for (const { label, remote } of remoteHands) {
    if (remote.authToken || !credentialRefInNamespace(remote.authTokenRef, credentialNamespace)) {
      failures.push(`${label} token must use a staging namespaced SecretVault reference`);
    }
  }
  const handStoreNamespace = env.AGENT_SAAS_STAGING_HAND_STORE_NAMESPACE?.trim();
  const productionHandStoreNamespace = env.AGENT_SAAS_PRODUCTION_HAND_STORE_NAMESPACE?.trim();
  if (
    !handStoreNamespace ||
    !productionHandStoreNamespace ||
    handStoreNamespace === productionHandStoreNamespace
  ) {
    failures.push('staging and production Hand store namespaces must be explicit and distinct');
  }

  for (const key of ['NAMESPACE', 'PVC', 'SERVICE_ACCOUNT'] as const) {
    const stagingValue = env[`AGENT_SAAS_STAGING_ACS_${key}`]?.trim();
    const productionValue = env[`AGENT_SAAS_PRODUCTION_ACS_${key}`]?.trim();
    if (!stagingValue || !productionValue || stagingValue === productionValue) {
      failures.push(`staging and production ACS ${key} identities must be explicit and distinct`);
    }
  }
  const acsReady = env.AGENT_SAAS_STAGING_ACS_READY;
  if (acsReady !== '0' && acsReady !== '1') {
    failures.push('AGENT_SAAS_STAGING_ACS_READY must explicitly be 0 or 1');
  }
  if (acsReady !== '1' && config.toolControls?.enabled !== false) {
    failures.push('platform tool execution must be explicitly disabled until Staging ACS is ready');
  }

  const oauthHosts = allowedHosts(env.AGENT_SAAS_STAGING_OAUTH_HOSTS);
  const codexEndpoint =
    config.codexSubscription?.endpoint ?? 'https://chatgpt.com/backend-api/codex/responses';
  if (config.codexSubscription?.enabled && !urlAllowed(codexEndpoint, oauthHosts))
    failures.push('OAuth endpoint is not staging-allowlisted');
  if (
    (env.GOOGLE_WORKSPACE_CONNECTOR_CLIENT_ID || env.GOOGLE_WORKSPACE_CONNECTOR_CLIENT_SECRET) &&
    !oauthHosts.has('accounts.google.com')
  )
    failures.push('Google OAuth endpoint is not staging-allowlisted');
  const oauthEnabled = env.AGENT_SAAS_STAGING_OAUTH_ENABLED;
  if (oauthEnabled !== '0' && oauthEnabled !== '1') {
    failures.push('AGENT_SAAS_STAGING_OAUTH_ENABLED must explicitly be 0 or 1');
  }
  const callbackHosts = allowedHosts(env.AGENT_SAAS_STAGING_OAUTH_CALLBACK_HOSTS);
  const callbackUrls = [env.MCP_OAUTH_CALLBACK_URL, env.CONNECTOR_OAUTH_CALLBACK_URL].filter(
    (value): value is string => Boolean(value),
  );
  if (oauthEnabled === '0' && callbackUrls.length > 0) {
    failures.push('OAuth callbacks must be absent while Staging OAuth is disabled');
  }
  if (oauthEnabled === '1') {
    if (
      callbackUrls.length !== 2 ||
      callbackUrls.some((value) => !urlAllowed(value, callbackHosts))
    ) {
      failures.push('Staging OAuth callbacks must use explicitly allowlisted Staging hosts');
    }
    const stagingClientNamespace = env.AGENT_SAAS_STAGING_OAUTH_CLIENT_NAMESPACE?.trim();
    const productionClientNamespace = env.AGENT_SAAS_PRODUCTION_OAUTH_CLIENT_NAMESPACE?.trim();
    if (
      !stagingClientNamespace ||
      !productionClientNamespace ||
      stagingClientNamespace === productionClientNamespace
    ) {
      failures.push('staging and production OAuth client namespaces must be explicit and distinct');
    }
  }

  const notificationHosts = allowedHosts(env.AGENT_SAAS_STAGING_NOTIFICATION_HOSTS);
  if (config.dingtalk?.enabled && !notificationHosts.has('api.dingtalk.com'))
    failures.push('DingTalk notification endpoint is not staging-allowlisted');
  if (
    config.dingtalkSendMessage?.enabled &&
    !urlAllowed(config.dingtalkSendMessage.endpoint, notificationHosts)
  )
    failures.push('DingTalk send endpoint is not staging-allowlisted');
  if (
    config.auth?.selfSignup?.dingtalkLeadWebhook &&
    !urlAllowed(config.auth.selfSignup.dingtalkLeadWebhook, notificationHosts)
  )
    failures.push('signup notification endpoint is not staging-allowlisted');
  if (config.webPush?.enabled) failures.push('web push notifications must be disabled in staging');
  if (env.AGENT_SAAS_STAGING_NOTIFICATION_MODE !== 'disabled') {
    failures.push(
      'Staging notifications must remain disabled until a verified test sink is configured',
    );
  }
  if (
    config.dingtalk?.enabled ||
    config.dingtalkSendMessage?.enabled ||
    config.auth?.selfSignup?.dingtalkLeadWebhook ||
    config.auth?.selfSignup?.sms?.provider === 'aliyun'
  ) {
    failures.push(
      'DingTalk and SMS production-capable notification paths must be disabled in staging',
    );
  }

  const db = config.runtimeEventStore;
  if (db?.backend !== 'pg') {
    failures.push('staging requires an explicitly identified PostgreSQL database');
  } else {
    const allowedHosts = new Set(
      (env.AGENT_SAAS_STAGING_DATABASE_HOSTS ?? '')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    );
    const databaseUrl = parseUrl(db.connectionString);
    const expectedDatabase = env.AGENT_SAAS_STAGING_DATABASE_NAME?.trim();
    const expectedUser = env.AGENT_SAAS_STAGING_DATABASE_USER?.trim();
    if (
      !databaseUrl ||
      allowedHosts.size === 0 ||
      !allowedHosts.has(databaseUrl.hostname.toLowerCase())
    )
      failures.push('database host is not in AGENT_SAAS_STAGING_DATABASE_HOSTS');
    if (!databaseUrl || !expectedDatabase || databaseUrl.pathname.slice(1) !== expectedDatabase)
      failures.push('database name does not match AGENT_SAAS_STAGING_DATABASE_NAME');
    if (!databaseUrl || !expectedUser || decodeURIComponent(databaseUrl.username) !== expectedUser)
      failures.push('database user does not match AGENT_SAAS_STAGING_DATABASE_USER');
  }

  if (!config.egress || !isStagingServerEgressSafe(config.egress)) {
    failures.push(
      'staging egress must use a valid HTTP(S) proxy to proxy all domains without bypass or fail-open',
    );
  }

  const markers = (env.AGENT_SAAS_PRODUCTION_MARKERS ?? '.prod.,production')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (
    markers.length > 0 &&
    values(config).some((item) => markers.some((marker) => item.toLowerCase().includes(marker)))
  ) {
    failures.push('staging configuration contains a production marker');
  }

  if (failures.length > 0)
    throw new Error(`Staging safety assertion failed:\n- ${failures.join('\n- ')}`);
  return { ...identity, safetyAttested: true };
}
