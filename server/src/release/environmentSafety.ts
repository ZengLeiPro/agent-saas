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

function hostname(connectionString: string): string | undefined {
  try { return new URL(connectionString).hostname.toLowerCase(); } catch { return undefined; }
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
  if (stagingRoot && config.secretVault?.backend === 'encrypted-file' && !isWithinRoot(stagingRoot, config.secretVault.filePath)) {
    failures.push('SecretVault file must be an absolute path within AGENT_SAAS_STAGING_ROOT');
  }

  const db = config.runtimeEventStore;
  if (db?.backend !== 'pg') {
    failures.push('staging requires an explicitly identified PostgreSQL database');
  } else {
    const allowedHosts = new Set((env.AGENT_SAAS_STAGING_DATABASE_HOSTS ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
    const host = hostname(db.connectionString);
    if (!host || allowedHosts.size === 0 || !allowedHosts.has(host)) failures.push('database host is not in AGENT_SAAS_STAGING_DATABASE_HOSTS');
  }

  const serverEgress = config.egress?.server;
  if (!serverEgress?.enabled || serverEgress.failOpen || serverEgress.matchDomains.length !== 0 || serverEgress.bypassDomains.length !== 0) {
    failures.push('staging egress must proxy all domains without bypass or fail-open');
  }

  const markers = (env.AGENT_SAAS_PRODUCTION_MARKERS ?? '.prod.,production').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (markers.length > 0 && values(config).some((item) => markers.some((marker) => item.toLowerCase().includes(marker)))) {
    failures.push('staging configuration contains a production marker');
  }

  if (failures.length > 0) throw new Error(`Staging safety assertion failed:\n- ${failures.join('\n- ')}`);
  return { ...identity, safetyAttested: true };
}
