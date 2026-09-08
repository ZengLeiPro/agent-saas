import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canonicalJson,
  digestBuffer,
  digestFile,
  DIGEST_PATTERN,
  SHA_PATTERN,
  OCI_IMAGE_REFERENCE_PATTERN,
} from './artifact-lib.mjs';
import { verifyArtifactIndex } from './verify-artifact.mjs';

function assert(value, message) {
  if (!value) throw new Error(message);
}
function safeEntry(entry) {
  assert(
    entry &&
      /^[a-z0-9][a-z0-9.-]*$/u.test(entry.path ?? '') &&
      DIGEST_PATTERN.test(entry.digest ?? '') &&
      Number.isSafeInteger(entry.size) &&
      entry.size > 0,
    'Invalid prepared artifact descriptor',
  );
  return entry;
}
function producerIdentity(env) {
  const producer = {
    repository: env.GITHUB_REPOSITORY,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
  };
  assert(
    typeof producer.repository === 'string' && /^[\w.-]+\/[\w.-]+$/u.test(producer.repository),
    'Prepared packages require a GitHub producer repository',
  );
  assert(
    typeof producer.workflowRef === 'string' &&
      producer.workflowRef.startsWith(`${producer.repository}/.github/workflows/ci.yml@`),
    'Prepared packages require the APP CI workflow',
  );
  assert(
    Number.isSafeInteger(producer.runId) &&
      producer.runId > 0 &&
      Number.isSafeInteger(producer.runAttempt) &&
      producer.runAttempt > 0,
    'Prepared packages require a concrete CI run and attempt',
  );
  assert(SHA_PATTERN.test(producer.sha ?? ''), 'Prepared packages require a complete producer SHA');
  assert(
    ['push', 'pull_request', 'workflow_dispatch'].includes(producer.event),
    'Unexpected package producer event',
  );
  return producer;
}

export async function writePreparedRelease({
  directory,
  sourceSha,
  acsOrchestrator,
  root,
  env = process.env,
}) {
  const producer = producerIdentity(env);
  assert(producer.sha === sourceSha, 'Prepared producer SHA differs from build SHA');
  const body = {
    schemaVersion: 1,
    sourceSha,
    producer,
    index: {
      path: 'artifact-index.json',
      ...(await digestFile(join(directory, 'artifact-index.json'))),
    },
    lockfile: await digestFile(join(root, 'pnpm-lock.yaml')),
    acsOrchestrator: safeEntry(acsOrchestrator),
  };
  const prepared = { ...body, digest: digestBuffer(Buffer.from(canonicalJson(body))) };
  await writeFile(join(directory, 'prepared-release.json'), `${canonicalJson(prepared)}\n`, {
    flag: 'wx',
  });
  return prepared;
}

export async function verifyPreparedRelease({ directory, sourceSha, root, expectedProducer }) {
  const prepared = JSON.parse(await readFile(join(directory, 'prepared-release.json'), 'utf8'));
  const { digest, ...body } = prepared;
  assert(
    prepared.schemaVersion === 1 && prepared.sourceSha === sourceSha && SHA_PATTERN.test(sourceSha),
    'Prepared package source identity mismatch',
  );
  assert(
    DIGEST_PATTERN.test(digest ?? '') && digestBuffer(Buffer.from(canonicalJson(body))) === digest,
    'Prepared package envelope digest mismatch',
  );
  const index = await verifyArtifactIndex(join(directory, 'artifact-index.json'), sourceSha);
  assert(
    index.schemaVersion === 2 && index.acsImage === null && !index.artifacts.acsOrchestrator,
    'Prepared package must not already bind an ACS image',
  );
  assert(prepared.index?.path === 'artifact-index.json', 'Prepared package index path mismatch');
  for (const entry of [prepared.index, prepared.acsOrchestrator]) {
    safeEntry(entry);
    const actual = await digestFile(join(directory, entry.path));
    assert(
      actual.digest === entry.digest && actual.size === entry.size,
      `Prepared artifact bytes differ: ${entry.path}`,
    );
  }
  const producer = producerIdentity({
    GITHUB_REPOSITORY: prepared.producer?.repository,
    GITHUB_WORKFLOW_REF: prepared.producer?.workflowRef,
    GITHUB_RUN_ID: prepared.producer?.runId,
    GITHUB_RUN_ATTEMPT: prepared.producer?.runAttempt,
    GITHUB_EVENT_NAME: prepared.producer?.event,
    GITHUB_REF: prepared.producer?.ref,
    GITHUB_SHA: prepared.producer?.sha,
  });
  assert(producer.sha === sourceSha, 'Prepared producer source mismatch');
  if (expectedProducer) {
    // These expected fields must come from the successful GitHub run lookup, not this envelope.
    for (const [key, expected] of Object.entries(expectedProducer))
      assert(producer[key] === expected, `Prepared producer ${key} mismatch`);
  }
  const sbom = JSON.parse(await readFile(join(directory, index.sbom.path), 'utf8'));
  assert(
    prepared.lockfile?.digest === sbom.lockfile.digest &&
      prepared.lockfile?.size === sbom.lockfile.size,
    'Prepared lockfile conflicts with SBOM',
  );
  if (root) {
    const lock = await digestFile(join(root, 'pnpm-lock.yaml'));
    assert(
      lock.digest === prepared.lockfile.digest && lock.size === prepared.lockfile.size,
      'Prepared lockfile differs from checked out source',
    );
  }
  return { prepared, index };
}

export async function consumePreparedRelease({
  directory,
  output,
  sourceSha,
  root,
  repository,
  runId,
  runAttempt,
  acsImage,
}) {
  assert(
    Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(runAttempt) && runAttempt > 0,
    'Expected CI run and attempt are required',
  );
  assert(
    typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/u.test(repository),
    'Expected CI repository is required',
  );
  const { prepared, index } = await verifyPreparedRelease({
    directory,
    sourceSha,
    root,
    expectedProducer: {
      repository,
      runId,
      runAttempt,
      sha: sourceSha,
      event: 'push',
      ref: 'refs/heads/main',
      workflowRef: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
    },
  });
  assert(
    !acsImage || OCI_IMAGE_REFERENCE_PATTERN.test(acsImage),
    'Sealing requires an immutable ACS image digest',
  );
  await mkdir(output, { recursive: true });
  const entries = [
    ...Object.values(index.artifacts),
    index.sbom,
    index.runtimeDependencies,
    ...(acsImage ? [prepared.acsOrchestrator] : []),
  ];
  for (const entry of entries)
    await cp(join(directory, safeEntry(entry).path), join(output, entry.path), {
      errorOnExist: true,
      force: false,
    });
  const { aggregateDigest: unused, ...body } = index;
  const sealedBody = {
    ...body,
    artifacts: {
      ...index.artifacts,
      ...(acsImage ? { acsOrchestrator: prepared.acsOrchestrator } : {}),
    },
    acsImage: acsImage
      ? { sourceSha, reference: acsImage, digest: `sha256:${acsImage.split('@sha256:')[1]}` }
      : null,
  };
  const sealed = {
    ...sealedBody,
    aggregateDigest: digestBuffer(Buffer.from(canonicalJson(sealedBody))),
  };
  await writeFile(join(output, 'artifact-index.json'), `${canonicalJson(sealed)}\n`, {
    flag: 'wx',
  });
  await writeFile(join(output, 'build-provenance.json'), `${canonicalJson(prepared)}\n`, {
    flag: 'wx',
  });
  await verifyArtifactIndex(join(output, 'artifact-index.json'), sourceSha);
  return sealed;
}
