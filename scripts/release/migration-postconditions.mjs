import { canonicalJson, digestBuffer, DIGEST_PATTERN } from './artifact-lib.mjs';
import { readFileSync } from 'node:fs';

export const POSTCONDITIONS_PATH = 'config/release-migration-postconditions.json';

export function assertMigrationPlanChecks(manifest) {
  const plan = manifest.migrationPlan;
  if (plan.phase !== 'expand') return;
  if (
    !plan.postconditions?.length ||
    digestBuffer(canonicalJson(plan.postconditions)) !== plan.postconditionsDigest
  )
    throw new Error(
      'Expand plan lacks bound database postconditions; create a new reviewed RC before deployment',
    );
}

/** Every changed schema provider must have a reviewed check bound to both source snapshots. */
export function selectPostconditions(inventory, catalog) {
  const checks = [];
  for (const file of inventory.filter((entry) => entry.classification === 'expand')) {
    const entry = catalog?.entries?.find(
      (item) =>
        item.path === file.path &&
        item.targetDigest === file.targetBlobDigest &&
        item.baselineDigest === file.baselineBlobDigest,
    );
    if (!entry?.checks?.length) throw new Error(`Missing database postconditions for ${file.path}`);
    for (const check of entry.checks) {
      if (
        !/^[a-zA-Z0-9_-]+$/u.test(check.id ?? '') ||
        !/^[a-zA-Z][a-zA-Z0-9.]*$/u.test(check.configPath ?? '') ||
        typeof check.sql !== 'string' ||
        !/^\s*(?:SELECT|WITH)\b/iu.test(check.sql) ||
        !Array.isArray(check.params) ||
        !check.description?.trim()
      )
        throw new Error(`Invalid database postcondition for ${file.path}`);
      checks.push({ ...check, sourcePath: file.path, sourceDigest: file.targetBlobDigest });
    }
  }
  if (new Set(checks.map((item) => item.id)).size !== checks.length)
    throw new Error('Duplicate database postcondition ID');
  return checks;
}

export function attachPostconditions(plan, snapshot, inventory, blockingReasons) {
  if (plan.phase === 'none') return {};
  try {
    const catalog = snapshot.repositoryPaths.has(POSTCONDITIONS_PATH)
      ? JSON.parse(snapshot.read(POSTCONDITIONS_PATH))
      : null;
    const checks = selectPostconditions(inventory, catalog);
    if (!checks.length) throw new Error('Expand plan must contain database postconditions');
    return { postconditions: checks, postconditionsDigest: digestBuffer(canonicalJson(checks)) };
  } catch (error) {
    blockingReasons.push(error.message);
    return {};
  }
}

export function assertDatabaseEvidence(
  manifest, evidence, environment, now = Date.now(), maxAgeMs = 300000,
) {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0)
    throw new Error('Invalid database evidence validation clock');
  const plan = manifest.migrationPlan;
  if (!['none', 'expand'].includes(plan?.phase))
    throw new Error('Unsupported migration readback phase');
  const checks = plan.postconditions;
  if (plan.phase === 'none') {
    const observed = Date.parse(evidence?.observedAt);
    if (
      typeof manifest.releaseId !== 'string' || !manifest.releaseId ||
      !DIGEST_PATTERN.test(manifest.digest ?? '') ||
      !DIGEST_PATTERN.test(plan.planDigest ?? '') ||
      !['staging', 'production'].includes(environment) ||
      plan.postconditionsDigest !== undefined || (checks !== undefined &&
        (!Array.isArray(checks) || checks.length !== 0)) ||
      evidence?.schemaVersion !== 1 ||
      evidence.releaseId !== manifest.releaseId ||
      evidence.manifestDigest !== manifest.digest ||
      evidence.planDigest !== plan.planDigest ||
      Object.hasOwn(evidence, 'postconditionsDigest') ||
      evidence.environment !== environment ||
      evidence.status !== 'not_required' ||
      !Number.isFinite(observed) || now - observed > maxAgeMs || observed > now + 60000 ||
      !Array.isArray(evidence.checks) || evidence.checks.length !== 0
    )
      throw new Error('No-migration readback is missing, stale or bound to a different release');
    return;
  }
  if (!checks?.length || digestBuffer(canonicalJson(checks)) !== plan.postconditionsDigest)
    throw new Error('Expand plan lacks bound database postconditions');
  if (
    evidence?.releaseId !== manifest.releaseId ||
    evidence.manifestDigest !== manifest.digest ||
    evidence.planDigest !== plan.planDigest ||
    evidence.postconditionsDigest !== plan.postconditionsDigest ||
    evidence.environment !== environment ||
    evidence.status !== 'passed' ||
    !Number.isFinite(Date.parse(evidence.observedAt)) ||
    now - Date.parse(evidence.observedAt) > maxAgeMs ||
    Date.parse(evidence.observedAt) > now + 60000 ||
    !Array.isArray(evidence.checks) ||
    evidence.checks.length !== checks.length
  )
    throw new Error(
      'Database migration readback is missing, stale or bound to a different release',
    );
  for (const [index, check] of checks.entries()) {
    const result = evidence.checks[index];
    if (
      result?.id !== check.id ||
      result.status !== 'passed' ||
      !result.database ||
      !result.targetDigest
    )
      throw new Error(`Database postcondition did not pass: ${check.id}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertMigrationPlanChecks(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
