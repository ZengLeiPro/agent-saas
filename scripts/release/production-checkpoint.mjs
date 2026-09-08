#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { canonicalJson, digestBuffer, DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';

const checksum = (body) => digestBuffer(Buffer.from(canonicalJson(body)));
export function assertCheckpointManifest(manifest) {
  assert.ok(
    [1, 2].includes(manifest?.schemaVersion) &&
      /^rc-\d{8}-\d{2,}$/u.test(manifest.releaseId ?? '') &&
      SHA_PATTERN.test(manifest.releaseSha ?? ''),
    'Checkpoint manifest identity is invalid',
  );
  const { digest, ...body } = manifest;
  assert.equal(
    digest,
    digestBuffer(
      Buffer.from(`agent-saas-release-manifest-v${manifest.schemaVersion}\0${canonicalJson(body)}`),
    ),
    'Checkpoint manifest digest mismatch',
  );
  return manifest;
}

export function createProductionCheckpoint({
  manifest,
  state,
  completed,
  runId,
  runAttempt,
  now = Date.now(),
}) {
  assertCheckpointManifest(manifest);
  assert.equal(completed?.state, 'completed', 'Checkpoint requires a completed promotion');
  assert.equal(completed.releaseId, manifest.releaseId);
  assert.equal(completed.manifestDigest, manifest.digest);
  assert.ok(
    Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(runAttempt) && runAttempt > 0,
    'Checkpoint requires run and attempt',
  );
  assert.equal(state?.schemaVersion, 1);
  assert.equal(state.environment, 'production');
  assert.equal(
    state.configIdentity?.status,
    'consistent',
    'Checkpoint requires a fresh strictly ready production readback',
  );
  assert.ok(
    Number.isFinite(Date.parse(state.observedAt)) &&
      now - Date.parse(state.observedAt) >= -30_000 &&
      now - Date.parse(state.observedAt) <= 300_000,
    'Checkpoint observation must be fresh (within five minutes)',
  );
  const { digest, ...stateBody } = state;
  assert.equal(digest, checksum(stateBody), 'Production state checksum mismatch');
  for (const [name, plan] of Object.entries(manifest.components)) {
    const observed = state.components?.[name];
    assert.equal(observed?.gitSha, plan.sourceSha, `${name} is not the committed source`);
    for (const key of name === 'acs'
      ? ['orchestratorArtifactDigest', 'sandboxImageDigest']
      : ['artifactDigest'])
      assert.equal(observed?.[key], plan[key], `${name} is not the committed artifact`);
  }
  const body = {
    schemaVersion: 1,
    environment: 'production',
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    manifest,
    productionState: state,
    completed,
    runId,
    runAttempt,
  };
  return { ...body, digest: checksum(body) };
}

export function baselineFromCheckpoint(checkpoint) {
  const { digest, ...body } = checkpoint;
  assert.ok(
    DIGEST_PATTERN.test(digest ?? '') && checksum(body) === digest,
    'Production checkpoint digest mismatch',
  );
  assert.equal(checkpoint.schemaVersion, 1);
  assert.equal(checkpoint.environment, 'production');
  assert.equal(checkpoint.releaseId, checkpoint.manifest?.releaseId);
  assert.equal(checkpoint.manifestDigest, checkpoint.manifest?.digest);
  createProductionCheckpoint({
    manifest: checkpoint.manifest,
    state: checkpoint.productionState,
    completed: checkpoint.completed,
    runId: checkpoint.runId,
    runAttempt: checkpoint.runAttempt,
    // Validate the historical envelope at its observation time; it is never current readiness.
    now: Date.parse(checkpoint.productionState.observedAt),
  });
  const state = checkpoint.productionState;
  // A historical observation supplies the desired baseline, never a current readiness/config claim.
  const baseline = {
    schemaVersion: 1,
    environment: 'production',
    releaseId: checkpoint.releaseId,
    observedAt: state.observedAt,
    components: state.components,
    baselineObservation: {
      kind: 'last_committed',
      releaseId: checkpoint.releaseId,
      observedAt: state.observedAt,
      checkpointDigest: digest,
    },
  };
  return { ...baseline, digest: checksum(baseline) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...argv] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(argv[i]?.startsWith('--') && argv[i + 1], 'Every option needs a value');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
  let value;
  if (command === 'baseline') value = baselineFromCheckpoint(await json(options.checkpoint));
  else if (command === 'create') {
    const entries = (await readFile(options.attestations, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    value = createProductionCheckpoint({
      manifest: await json(options.manifest),
      state: await json(options.state),
      completed: entries.at(-1),
      runId: Number(options['run-id']),
      runAttempt: Number(options['run-attempt']),
    });
  } else throw new Error('Expected create or baseline');
  await writeFile(options.output, `${canonicalJson(value)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(value.digest);
}
