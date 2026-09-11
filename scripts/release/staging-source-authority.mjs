import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEvidenceJson } from './evidence-file.mjs';
import { validateReleaseEvidenceDocument } from './release-evidence-schema.mjs';
import { assertCheckpointManifest } from './production-checkpoint.mjs';
import { AutomaticGitHub } from './automatic-release-github.mjs';
import {
  assertRequest,
  assertRun,
  assertStep,
  ID_PATTERN,
  normalizedComponents,
  hash,
  seal,
  unseal,
} from './automatic-release-contract.mjs';

export function createSourceProof({ manifest, authority, context, repository, now = Date.now() }) {
  assertCheckpointManifest(manifest);
  const { requestRecord, stepRecord, parentRun, run } = context;
  const request = assertRequest(requestRecord, parentRun, repository);
  const step = assertStep(stepRecord, request);
  assert.equal(step.stage, 'refresh');
  assert.equal(step.sourceSha, manifest.releaseSha);
  assert.equal(String(step.requestId), String(requestRecord.id));
  assertRun(run, repository, 'deploy-staging.yml', step.engineSha);
  assert.equal(run.display_title, step.key);
  assert.equal(run.run_attempt, 1);
  validateReleaseEvidenceDocument(authority, { expectedSha: step.sourceSha });
  assert(!authority.baselineObservation, 'Automatic refresh cannot use a historical checkpoint');
  return seal({
    schemaVersion: 1,
    kind: 'staging-source-delegation',
    repository,
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    sourceSha: step.sourceSha,
    engineSha: step.engineSha,
    stagingRunId: String(run.id),
    stagingRunAttempt: String(run.run_attempt),
    requestId: String(requestRecord.id),
    requestDigest: request.digest,
    stepId: String(stepRecord.id),
    stepDigest: step.digest,
    authoritativeEvidenceDigest: authority.evidenceDigest,
    createdAt: new Date(now).toISOString(),
  });
}

/** All records in `bundle` are independently fetched GitHub objects, not trusted archive claims. */
export function validateSourceAuthority(bundle, { manifest, run, deployment, repository }) {
  assert(bundle && typeof bundle === 'object');
  const { proof, authority, requestRecord, stepRecord, parentRun } = bundle;
  unseal(proof, 'staging-source-delegation');
  assertCheckpointManifest(manifest);
  const request = assertRequest(requestRecord, parentRun, repository);
  const step = assertStep(stepRecord, request);
  assert.equal(step.stage, 'refresh');
  assert.equal(String(step.requestId), String(requestRecord.id));
  assert.equal(proof.requestId, String(requestRecord.id));
  assert.equal(proof.stepId, String(stepRecord.id));
  assert.equal(proof.requestDigest, request.digest);
  assert.equal(proof.stepDigest, step.digest);
  assert.equal(proof.repository, repository);
  assert.equal(proof.releaseId, manifest.releaseId);
  assert.equal(proof.manifestDigest, manifest.digest);
  assert.equal(proof.sourceSha, manifest.releaseSha);
  assert.equal(proof.sourceSha, request.target.sourceSha);
  assert.equal(proof.engineSha, step.engineSha);
  assert.equal(proof.stagingRunId, String(run.id));
  assert.equal(proof.stagingRunAttempt, String(run.run_attempt));
  assert.equal(run.run_attempt, 1);
  assertRun(run, repository, 'deploy-staging.yml', proof.engineSha);
  assert.equal(run.display_title, step.key);
  assert.equal(deployment.payload?.automaticSource?.digest, proof.digest);
  assert.equal(String(deployment.payload?.automaticSource?.stepId), proof.stepId);
  assert.equal(deployment.sha, proof.sourceSha);
  assert.equal(deployment.environment, 'staging');
  assert.equal(deployment.payload?.releaseId, manifest.releaseId);
  assert.equal(deployment.payload?.manifestDigest, manifest.digest);
  assert.equal(String(deployment.payload?.stagingRunId), String(run.id));
  const started = Date.parse(run.run_started_at);
  const created = Date.parse(proof.createdAt);
  assert(
    Number.isFinite(created) &&
      created >= started - 60000 &&
      created <= Date.parse(run.updated_at) + 60000,
  );
  assert(Date.parse(requestRecord.created_at) <= Date.parse(stepRecord.created_at) + 1000);
  assert(Date.parse(stepRecord.created_at) <= Date.parse(run.created_at) + 1000);
  validateReleaseEvidenceDocument(authority, { expectedSha: proof.sourceSha });
  assert.equal(authority.evidenceDigest, proof.authoritativeEvidenceDigest);
  assert(!authority.baselineObservation, 'Refreshed authority must be from a live baseline');
  assert.equal(
    hash(normalizedComponents(authority.productionBaseline)),
    hash(normalizedComponents(manifest.productionBaseline)),
  );
  assert.deepEqual(authority.migrationPlan, manifest.migrationPlan);
  return proof.engineSha;
}

export async function readOptionalSourceAuthority(directory) {
  const path = join(directory, 'source-authority.json');
  try {
    await access(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  return readEvidenceJson(path, 4194304);
}

export async function collectSourceAuthority(client, directory, manifest) {
  const deployment = await readEvidenceJson(join(directory, 'deployment.json'));
  assert(deployment.payload?.automaticSource, 'Missing deployment source delegation');
  const proof = await readEvidenceJson(
    join(directory, 'attempt-evidence/staging-source-binding.json'),
  );
  unseal(proof, 'staging-source-delegation');
  assert(ID_PATTERN.test(proof.stepId) && ID_PATTERN.test(proof.requestId));
  const stepRecord = await client.api(`deployments/${proof.stepId}`);
  const requestRecord = await client.api(`deployments/${proof.requestId}`);
  assert(ID_PATTERN.test(requestRecord.payload?.parentRunId ?? ''));
  const parentRun = await client.api(`actions/runs/${requestRecord.payload.parentRunId}`);
  const authority = await readEvidenceJson(
    join(directory, 'attempt-evidence/authoritative-evidence.json'),
    2097152,
  );
  const bundle = { proof, authority, stepRecord, requestRecord, parentRun, deployment };
  const run = await readEvidenceJson(join(directory, 'staging-attempt.json'));
  validateSourceAuthority(bundle, { manifest, run, deployment, repository: client.repository });
  await writeFile(join(directory, 'source-authority.json'), JSON.stringify(bundle) + '\n');
  return bundle;
}

async function main([mode, directory, manifestPath, repository]) {
  const manifest = await readEvidenceJson(manifestPath, 1048576);
  if (mode === 'collect') {
    await collectSourceAuthority(new AutomaticGitHub(repository), directory, manifest);
    return;
  }
  assert.equal(mode, 'create');
  const proof = createSourceProof({
    manifest,
    repository,
    authority: await readEvidenceJson(join(directory, 'authoritative-evidence.json'), 2097152),
    context: await readEvidenceJson(join(directory, 'automation-context.json'), 2097152),
  });
  await writeFile(join(directory, 'staging-source-binding.json'), JSON.stringify(proof) + '\n', {
    flag: 'wx',
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch {
    console.error('Staging source delegation rejected');
    process.exitCode = 1;
  }
}
