#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { canonicalJson, digestBuffer } from '../release/artifact-lib.mjs';

export const REQUIRED_ISOLATION_PROBES = Object.freeze([
  'database-role-cannot-read-or-write-production',
  'oss-identity-cannot-write-production-bucket',
  'nas-client-is-all-squashed-and-mounted-to-staging-subdirectory',
  'notification-identity-cannot-deliver-to-production',
  'api-worker-cannot-connect-production-hand-or-acs',
  'acs-service-account-cannot-read-production-namespace-resources',
  'sandbox-workspace-uses-staging-only-pvc-and-paths',
]);

export const SHARED_NAS_RESIDUAL_RISK = 'privileged-host-can-remount-shared-filesystem-root';

const LOGICAL_SHARED_NAS_PROBES = new Set([
  'nas-client-is-all-squashed-and-mounted-to-staging-subdirectory',
  'sandbox-workspace-uses-staging-only-pvc-and-paths',
]);

function isFreshProbe(probe, now, maxAgeMs) {
  const observedAt = Date.parse(probe.observedAt ?? '');
  const observedDigest = digestBuffer(Buffer.from(canonicalJson(probe.observed ?? null)));
  return (
    probe.evidenceDigest === observedDigest &&
    Number.isFinite(observedAt) &&
    observedAt <= now + 60_000 &&
    now - observedAt <= maxAgeMs
  );
}

function assertProductionOssProbe(probe) {
  const observed = probe.observed;
  if (
    !observed ||
    typeof observed.bucket !== 'string' ||
    !observed.bucket ||
    typeof observed.sentinelKey !== 'string' ||
    !observed.sentinelKey ||
    observed.sentinelExists !== true ||
    observed.forbidOverwrite !== true ||
    observed.responseStatus !== 403 ||
    !/^AccessDenied(?:$|[A-Za-z0-9_-])/u.test(observed.responseCode ?? '')
  ) {
    throw new Error('Production OSS probe did not prove an authorization 403/AccessDenied denial');
  }
}

function assertSharedNasProbe(probe) {
  if (
    probe.status !== 'verified-with-accepted-residual-risk' ||
    probe.sourceEnvironment !== 'staging' ||
    probe.targetEnvironment !== 'staging' ||
    probe.observed?.residualRisk !== SHARED_NAS_RESIDUAL_RISK
  ) {
    throw new Error(`Shared NAS probe did not bind the accepted residual risk: ${probe.id}`);
  }

  if (probe.id === 'nas-client-is-all-squashed-and-mounted-to-staging-subdirectory') {
    if (
      probe.observed.mountTarget !== '/mnt/agent-saas-staging' ||
      !/^[a-z0-9-]+\.cn-shenzhen\.nas\.aliyuncs\.com:\/agent-saas-staging$/u.test(
        probe.observed.mountSource ?? '',
      ) ||
      probe.observed.serverPath !== '/agent-saas-staging' ||
      probe.observed.userAccess !== 'all_squash' ||
      !/^\d{1,3}(?:\.\d{1,3}){3}\/32$/u.test(probe.observed.sourceCidr ?? '') ||
      probe.observed.productionNamesVisible !== false
    ) {
      throw new Error(
        `Shared NAS client probe did not prove the staging subdirectory mount: ${probe.id}`,
      );
    }
    return;
  }

  if (
    probe.observed.namespace !== 'agent-saas-staging' ||
    probe.observed.pvc !== 'agent-saas-staging-workspace' ||
    probe.observed.workspaceRoot !== '/mnt/agent-saas-staging/workspaces' ||
    probe.observed.productionWorkspaceMounted !== false ||
    probe.observed.sharedFilesystemLogicalIsolation !== true
  ) {
    throw new Error(
      `Shared NAS sandbox probe did not prove staging-only PVC and paths: ${probe.id}`,
    );
  }
}

export function assertIsolationEvidence(value, { now = Date.now(), maxAgeMs = 60 * 60_000 } = {}) {
  if (value?.schemaVersion !== 1 || value?.environment !== 'staging')
    throw new Error('Isolation evidence must identify Staging schema v1');
  if (!Array.isArray(value.probes)) throw new Error('Isolation evidence probes are required');
  const byId = new Map(value.probes.map((probe) => [probe.id, probe]));
  for (const id of REQUIRED_ISOLATION_PROBES) {
    const probe = byId.get(id);
    if (!probe) throw new Error(`Missing isolation probe: ${id}`);
    if (!isFreshProbe(probe, now, maxAgeMs)) {
      throw new Error(`Isolation probe is missing a fresh evidence digest: ${id}`);
    }
    if (LOGICAL_SHARED_NAS_PROBES.has(id)) {
      assertSharedNasProbe(probe);
    } else if (
      probe.status !== 'denied' ||
      probe.sourceEnvironment !== 'staging' ||
      probe.targetEnvironment !== 'production'
    ) {
      throw new Error(`Isolation probe did not prove a fresh production denial: ${id}`);
    }
    if (id === 'oss-identity-cannot-write-production-bucket') assertProductionOssProbe(probe);
  }
  const normalized = canonicalJson(
    [...byId.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
  );
  return {
    schemaVersion: 1,
    environment: 'staging',
    status: 'verified-with-accepted-residual-risk',
    residualRisks: [SHARED_NAS_RESIDUAL_RISK],
    evidenceDigest: digestBuffer(Buffer.from(normalized)),
    observedAt: new Date(now).toISOString(),
  };
}

if (process.env.AGENT_SAAS_EMBEDDED !== 'true' && import.meta.url === `file://${process.argv[1]}`) {
  const [input, output] = process.argv.slice(2);
  if (!input) throw new Error('usage: assert-isolation.mjs <evidence.json> [summary.json]');
  const value = assertIsolationEvidence(JSON.parse(await readFile(input, 'utf8')));
  if (output) await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
