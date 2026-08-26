import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type { AppConfig } from '../app/config.js';
import { readRuntimeIdentity, type RuntimeIdentity } from './runtimeIdentity.js';

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
  if (
    stagingRoot &&
    config.secretVault?.backend === 'encrypted-file' &&
    !isWithinRoot(stagingRoot, config.secretVault.filePath)
  ) {
    failures.push('SecretVault file must be an absolute path within AGENT_SAAS_STAGING_ROOT');
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

  const serverEgress = config.egress?.server;
  let supportedProxy = false;
  try {
    supportedProxy = ['http:', 'https:'].includes(new URL(serverEgress?.proxyUrl ?? '').protocol);
  } catch {
    supportedProxy = false;
  }
  if (
    !serverEgress?.enabled ||
    !supportedProxy ||
    serverEgress.failOpen ||
    serverEgress.matchDomains.length !== 0 ||
    serverEgress.bypassDomains.length !== 0
  ) {
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
