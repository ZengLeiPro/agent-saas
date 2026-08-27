import { describe, expect, it } from 'vitest';
import { createReleaseCandidate, type ReleaseCandidateEvidence } from './createReleaseCandidate.js';
import { validateManifest } from './releaseManifestStore.js';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const SERVER = `sha256:${'1'.repeat(64)}`;
const WEB = `sha256:${'2'.repeat(64)}`;
const ORCH = `sha256:${'3'.repeat(64)}`;
const IMAGE = `sha256:${'4'.repeat(64)}`;
const changedServer = `sha256:${'5'.repeat(64)}`;

function evidence(): ReleaseCandidateEvidence {
  const productionBaseline = {
    web: { sourceSha: BASE, artifactDigest: WEB },
    api: { sourceSha: BASE, artifactDigest: SERVER },
    runtimeWorker: { sourceSha: BASE, artifactDigest: SERVER },
    acs: { sourceSha: BASE, orchestratorArtifactDigest: ORCH, sandboxImageDigest: IMAGE },
  };
  return {
    releaseId: 'rc-20260826-01',
    releaseSha: SHA,
    createdAt: '2026-08-26T00:00:00.000Z',
    createdBy: 'release-operator',
    expiresAt: '2026-08-27T00:00:00.000Z',
    compatibilityEvidenceDigest: `sha256:${'8'.repeat(64)}`,
    integrationCandidates: [
      { candidateId: '85a9cb68-4130-4c0a-aec3-e4cc9c671bd5', revision: 3, mergedCommitOid: SHA },
    ],
    sourcePullRequests: [201],
    checks: {
      appCi: { status: 'success', headSha: SHA, runId: 100 },
      acsImpact: { status: 'success', headSha: SHA, runId: 101 },
      integrationReceipt: { status: 'success', subjectDigest: `sha256:${'6'.repeat(64)}` },
    },
    productionBaseline,
    affectedComponents: ['api', 'runtimeWorker'],
    builtArtifacts: {
      serverBundle: {
        uri: 'oss://agent-saas-releases/server.tgz',
        digest: changedServer,
        size: 10,
      },
      webAssets: { uri: 'oss://agent-saas-releases/web.tgz', digest: WEB, size: 10 },
    },
    baselineArtifacts: {
      serverBundle: { uri: 'oss://agent-saas-releases/base-server.tgz', digest: SERVER, size: 10 },
      webAssets: { uri: 'oss://agent-saas-releases/base-web.tgz', digest: WEB, size: 10 },
      acsOrchestrator: { uri: 'oss://agent-saas-releases/base-acs.tgz', digest: ORCH, size: 10 },
      acsImage: { repository: 'registry/acs', digest: IMAGE },
    },
    migrationPlan: {
      phase: 'none',
      planDigest: `sha256:${'7'.repeat(64)}`,
      confirmation: 'not_required',
      contract: 'separate_release',
    },
  };
}

describe('createReleaseCandidate', () => {
  it('binds deploy artifacts while preserving immutable keep identities', () => {
    const manifest = createReleaseCandidate(evidence());
    expect(validateManifest(manifest)).toEqual(manifest);
    expect(manifest.components.api).toMatchObject({
      action: 'deploy',
      artifactDigest: changedServer,
    });
    expect(manifest.components.web).toEqual({
      action: 'keep',
      sourceSha: BASE,
      artifactDigest: WEB,
    });
    expect(manifest.artifacts.acsOrchestrator.required).toBe(false);
  });

  it('rejects API and Worker action divergence', () => {
    const input = evidence();
    input.affectedComponents = ['api'];
    expect(() => createReleaseCandidate(input)).toThrow(/must deploy or keep together/u);
  });

  it('rejects ACS deploy without exact orchestrator and image artifacts', () => {
    const input = evidence();
    input.affectedComponents = ['acs'];
    expect(() => createReleaseCandidate(input)).toThrow(/exact immutable artifacts/u);
  });
});
