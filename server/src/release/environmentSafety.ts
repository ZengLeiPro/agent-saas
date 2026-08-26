import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AppConfig } from '../app/config.js';
import { isStagingServerEgressSafe } from '../runtime/egressPolicy.js';
import { readRuntimeIdentity, type RuntimeIdentity } from './runtimeIdentity.js';

function values(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(values);
  if (value && typeof value === 'object') return Object.values(value).flatMap(values);
  return [];
}

function hostname(connectionString: string): string | undefined {
  try { return new URL(connectionString).hostname.toLowerCase(); } catch { return undefined; }
}

function allowedHosts(envValue: string | undefined): Set<string> {
  return new Set((envValue ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function urlAllowed(value: string | undefined, allowlist: Set<string>): boolean {
  if (!value || allowlist.size === 0) return false;
  try { return allowlist.has(new URL(value).hostname.toLowerCase()); } catch { return false; }
}

function isWithinRoot(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
  try {
    const pathFromRoot = relative(realpathSync(root), realpathSync(candidate));
    return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
  } catch {
    return false;
  }
}

/**
 * Staging is a separate safety domain, not NODE_ENV=staging. This pure startup
 * assertion fails closed before any service, scheduler, or connector starts.
 */
export function assertRuntimeEnvironmentSafety(config: AppConfig, env: NodeJS.ProcessEnv = process.env): RuntimeIdentity {
  const identity = readRuntimeIdentity(env);
  if (identity.environment !== 'staging') return { ...identity, safetyAttested: true };

  const failures: string[] = [];
  if (config.cron?.enabled !== false) failures.push('staging cron.enabled must be explicitly false');
  if (env.AGENT_SAAS_ACS_ENABLED === '1' || (config.tenantRemoteHands?.hands.length ?? 0) > 0) failures.push('staging must disable ACS and remote Hand execution');

  const stagingRoot = env.AGENT_SAAS_STAGING_ROOT?.trim();
  if (!stagingRoot || !isAbsolute(stagingRoot)) failures.push('AGENT_SAAS_STAGING_ROOT must be an absolute path');
  if (stagingRoot && !isWithinRoot(stagingRoot, config.agent.cwd ?? '')) {
    failures.push('agent workspace must be an absolute path within AGENT_SAAS_STAGING_ROOT');
  }
  const sharedDir = resolve(config.agent.cwd ?? '', config.agent.sharedDir ?? '.shared');
  if (stagingRoot && !isWithinRoot(stagingRoot, sharedDir)) failures.push('agent sharedDir/NAS must be within AGENT_SAAS_STAGING_ROOT');
  if (stagingRoot && config.secretVault?.backend === 'encrypted-file' && !isWithinRoot(stagingRoot, config.secretVault.filePath)) {
    failures.push('SecretVault file must be an absolute path within AGENT_SAAS_STAGING_ROOT');
  }
  const vaultHosts = allowedHosts(env.AGENT_SAAS_STAGING_SECRET_VAULT_HOSTS);
  if (config.secretVault?.backend === 'http' && !urlAllowed(config.secretVault.baseUrl, vaultHosts)) failures.push('HTTP SecretVault host is not staging-allowlisted');
  const handHosts = allowedHosts(env.AGENT_SAAS_STAGING_HAND_HOSTS);
  if (config.serverRemote && !urlAllowed(config.serverRemote.baseUrl, handHosts)) failures.push('serverRemote host is not staging-allowlisted');

  const oauthHosts = allowedHosts(env.AGENT_SAAS_STAGING_OAUTH_HOSTS);
  const codexEndpoint = config.codexSubscription?.endpoint ?? 'https://chatgpt.com/backend-api/codex/responses';
  if (config.codexSubscription?.enabled && !urlAllowed(codexEndpoint, oauthHosts)) failures.push('OAuth endpoint is not staging-allowlisted');
  if ((env.GOOGLE_WORKSPACE_CONNECTOR_CLIENT_ID || env.GOOGLE_WORKSPACE_CONNECTOR_CLIENT_SECRET)
      && !oauthHosts.has('accounts.google.com')) failures.push('Google OAuth endpoint is not staging-allowlisted');

  const notificationHosts = allowedHosts(env.AGENT_SAAS_STAGING_NOTIFICATION_HOSTS);
  if (config.dingtalk?.enabled && !notificationHosts.has('api.dingtalk.com')) failures.push('DingTalk notification endpoint is not staging-allowlisted');
  if (config.dingtalkSendMessage?.enabled && !urlAllowed(config.dingtalkSendMessage.endpoint, notificationHosts)) failures.push('DingTalk send endpoint is not staging-allowlisted');
  if (config.auth?.selfSignup?.dingtalkLeadWebhook && !urlAllowed(config.auth.selfSignup.dingtalkLeadWebhook, notificationHosts)) failures.push('signup notification endpoint is not staging-allowlisted');
  if (config.webPush?.enabled) failures.push('web push notifications must be disabled in staging');

  const db = config.runtimeEventStore;
  if (db?.backend !== 'pg') {
    failures.push('staging requires an explicitly identified PostgreSQL database');
  } else {
    const allowedHosts = new Set((env.AGENT_SAAS_STAGING_DATABASE_HOSTS ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
    const host = hostname(db.connectionString);
    if (!host || allowedHosts.size === 0 || !allowedHosts.has(host)) failures.push('database host is not in AGENT_SAAS_STAGING_DATABASE_HOSTS');
  }

  if (!config.egress || !isStagingServerEgressSafe(config.egress)) {
    failures.push('staging egress must use a valid HTTP(S) proxy to proxy all domains without bypass or fail-open');
  }

  const markers = (env.AGENT_SAAS_PRODUCTION_MARKERS ?? '.prod.,production').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (markers.length > 0 && values(config).some((item) => markers.some((marker) => item.toLowerCase().includes(marker)))) {
    failures.push('staging configuration contains a production marker');
  }

  if (failures.length > 0) throw new Error(`Staging safety assertion failed:\n- ${failures.join('\n- ')}`);
  return { ...identity, safetyAttested: true };
}
