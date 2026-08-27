import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalJson } from '@agent/shared';
import { ReleaseAttestationStore } from './releaseAttestationStore.js';
import { getPromotionEligibility } from './releasePolicy.js';
import { validateManifest } from './releaseManifestStore.js';

function parse(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    output[key.slice(2)] = value;
  }
  return output;
}

interface ObservedComponent {
  gitSha: string;
  artifactDigest?: string;
  orchestratorArtifactDigest?: string;
  sandboxImageDigest?: string;
}

export function baselineFromState(state: { components: Record<string, ObservedComponent> }) {
  const components = state.components;
  for (const name of ['web', 'api', 'runtimeWorker', 'acs']) {
    if (!components[name]) throw new Error(`Production state is missing ${name}`);
  }
  return {
    web: { sourceSha: components.web.gitSha, artifactDigest: components.web.artifactDigest },
    api: { sourceSha: components.api.gitSha, artifactDigest: components.api.artifactDigest },
    runtimeWorker: {
      sourceSha: components.runtimeWorker.gitSha,
      artifactDigest: components.runtimeWorker.artifactDigest,
    },
    acs: {
      sourceSha: components.acs.gitSha,
      orchestratorArtifactDigest: components.acs.orchestratorArtifactDigest,
      sandboxImageDigest: components.acs.sandboxImageDigest,
    },
  };
}

export function validateApprovalReason(
  reason: string | undefined,
  expected: { releaseId: string; digest: string },
): Record<string, unknown> {
  let approval: Record<string, unknown>;
  try {
    approval = JSON.parse(reason ?? '') as Record<string, unknown>;
  } catch {
    throw new Error('Approval attestation lacks structured Staging evidence');
  }
  for (const key of [
    'releaseId',
    'manifestDigest',
    'stagingDeploymentId',
    'e2eRunId',
    'triggeredAt',
  ]) {
    if (!approval[key]) throw new Error(`Approval attestation is missing ${key}`);
  }
  if (approval.releaseId !== expected.releaseId || approval.manifestDigest !== expected.digest)
    throw new Error('Approval attestation is not bound to this Manifest');
  const e2e = approval.e2eSummary as Record<string, unknown> | undefined;
  if (
    e2e?.schemaVersion !== 1 ||
    e2e.status !== 'passed' ||
    e2e.traceMode !== 'on' ||
    !Number.isSafeInteger(e2e.scenarioCount) ||
    Number(e2e.scenarioCount) < 1 ||
    !Number.isSafeInteger(e2e.executionCount) ||
    Number(e2e.executionCount) < Number(e2e.scenarioCount) ||
    !Array.isArray(e2e.projects) ||
    !e2e.projects.includes('desktop-chromium') ||
    !e2e.projects.includes('mobile-chromium')
  ) {
    throw new Error('Approval attestation lacks a passed scenario-level Staging E2E summary');
  }
  const { evidenceDigest, ...e2eBody } = e2e;
  const expectedE2eDigest = `sha256:${createHash('sha256').update(canonicalJson(e2eBody)).digest('hex')}`;
  if (evidenceDigest !== expectedE2eDigest)
    throw new Error('Approval attestation Staging E2E summary digest is invalid');
  return approval;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parse(process.argv.slice(2));
  if (!options.manifest || !options['attestation-root'] || !options['production-state'])
    throw new Error('manifest, attestation-root and production-state are required');
  const manifest = validateManifest(JSON.parse(await readFile(options.manifest, 'utf8')));
  const state = JSON.parse(await readFile(options['production-state'], 'utf8')) as {
    components: Record<string, ObservedComponent>;
  };
  const store = new ReleaseAttestationStore(options['attestation-root']);
  const attestations = await store.read(manifest.releaseId, manifest.digest);
  const latest = attestations.list().at(-1);
  if (latest?.state !== 'approved') throw new Error('Latest release attestation is not approved');
  const approval = validateApprovalReason(latest.reason, manifest);
  const gitOk = (args: string[]) => {
    try {
      execFileSync('git', args, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  };
  const eligibility = getPromotionEligibility({
    attestations,
    manifestDigest: manifest.digest,
    expectedManifestDigest: manifest.digest,
    isMainAncestor: gitOk(['merge-base', '--is-ancestor', manifest.releaseSha, 'origin/main']),
    minimumPromotableShaSatisfied: gitOk([
      'merge-base',
      '--is-ancestor',
      manifest.promotionPolicy.minimumPromotableSha,
      manifest.releaseSha,
    ]),
    productionBaselineMatches:
      canonicalJson(baselineFromState(state)) === canonicalJson(manifest.productionBaseline),
    expiresAt: manifest.promotionPolicy.expiresAt,
  });
  if (!eligibility.promotable) throw new Error(eligibility.blockingReasons.join(' '));
  process.stdout.write(
    `${JSON.stringify({ promotable: true, releaseId: manifest.releaseId, approval })}\n`,
  );
}
