#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const REQUIRED_ISOLATION_PROBES = Object.freeze([
  'database-role-cannot-read-or-write-production',
  'oss-identity-cannot-write-production-bucket',
  'nas-identity-cannot-traverse-production-root',
  'notification-delivery-reaches-test-sink-only',
  'api-worker-cannot-connect-production-hand-or-acs',
  'acs-service-account-cannot-read-production-namespace-resources',
  'sandbox-cannot-mount-or-traverse-production-workspace',
]);

export function assertIsolationEvidence(value, { now = Date.now(), maxAgeMs = 60 * 60_000 } = {}) {
  if (value?.schemaVersion !== 1 || value?.environment !== 'staging')
    throw new Error('Isolation evidence must identify Staging schema v1');
  if (!Array.isArray(value.probes)) throw new Error('Isolation evidence probes are required');
  const byId = new Map(value.probes.map((probe) => [probe.id, probe]));
  for (const id of REQUIRED_ISOLATION_PROBES) {
    const probe = byId.get(id);
    if (!probe) throw new Error(`Missing isolation probe: ${id}`);
    const observedAt = Date.parse(probe.observedAt ?? '');
    if (
      probe.status !== 'denied' ||
      probe.sourceEnvironment !== 'staging' ||
      probe.targetEnvironment !== 'production' ||
      !/^sha256:[a-f0-9]{64}$/u.test(probe.evidenceDigest ?? '') ||
      !Number.isFinite(observedAt) ||
      observedAt > now + 60_000 ||
      now - observedAt > maxAgeMs
    ) {
      throw new Error(`Isolation probe did not prove a fresh production denial: ${id}`);
    }
  }
  const normalized = JSON.stringify(
    [...byId.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
  );
  return {
    schemaVersion: 1,
    environment: 'staging',
    status: 'verified',
    evidenceDigest: `sha256:${createHash('sha256').update(normalized).digest('hex')}`,
    observedAt: new Date(now).toISOString(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output] = process.argv.slice(2);
  if (!input) throw new Error('usage: assert-isolation.mjs <evidence.json> [summary.json]');
  const value = assertIsolationEvidence(JSON.parse(await readFile(input, 'utf8')));
  if (output) await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
