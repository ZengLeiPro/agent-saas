import { canonicalJson, digestBuffer } from './artifact-lib.mjs';

export const RELEASE_EVIDENCE_SHA = 'a'.repeat(40);
export const RELEASE_EVIDENCE_BASE_SHA = 'b'.repeat(40);

export function createValidReleaseEvidence(overrides = {}) {
  const body = {
    schemaVersion: 1,
    ok: true,
    releaseSha: RELEASE_EVIDENCE_SHA,
    productionBaselineStatus: 'known',
    releasePullRequest: {
      number: 201,
      headSha: 'c'.repeat(40),
      mergeCommitOid: RELEASE_EVIDENCE_SHA,
      state: 'MERGED',
    },
    integrationCandidates: [],
    sourcePullRequests: [201],
    checks: {
      appCi: { status: 'success', headSha: RELEASE_EVIDENCE_SHA, runId: 100 },
      acsImpact: { status: 'success', headSha: RELEASE_EVIDENCE_SHA, runId: 101 },
      mergeReceipt: {
        status: 'success',
        subjectDigest: `sha256:${'6'.repeat(64)}`,
      },
    },
    productionBaseline: {
      web: {
        sourceSha: RELEASE_EVIDENCE_BASE_SHA,
        artifactDigest: `sha256:${'2'.repeat(64)}`,
      },
      api: {
        sourceSha: RELEASE_EVIDENCE_BASE_SHA,
        artifactDigest: `sha256:${'1'.repeat(64)}`,
      },
      runtimeWorker: {
        sourceSha: RELEASE_EVIDENCE_BASE_SHA,
        artifactDigest: `sha256:${'1'.repeat(64)}`,
      },
      acs: {
        sourceSha: RELEASE_EVIDENCE_BASE_SHA,
        orchestratorArtifactDigest: `sha256:${'3'.repeat(64)}`,
        sandboxImageDigest: `sha256:${'4'.repeat(64)}`,
      },
    },
    baselineArtifacts: {
      serverBundle: {
        uri: 'oss://agent-saas-releases/baseline/server.tgz',
        digest: `sha256:${'1'.repeat(64)}`,
        size: 10,
      },
      webAssets: {
        uri: 'oss://agent-saas-releases/baseline/web.tgz',
        digest: `sha256:${'2'.repeat(64)}`,
        size: 11,
      },
      acsOrchestrator: {
        uri: 'oss://agent-saas-releases/baseline/acs-orchestrator.tgz',
        digest: `sha256:${'3'.repeat(64)}`,
        size: 12,
      },
      acsImage: {
        repository: 'registry.example.com/agent-saas/acs-sandbox',
        digest: `sha256:${'4'.repeat(64)}`,
      },
    },
    affectedComponents: ['web'],
    migrationPlan: {
      phase: 'none',
      planDigest: `sha256:${'7'.repeat(64)}`,
      confirmation: 'not_required',
      contract: 'separate_release',
    },
    ...overrides,
  };
  return { ...body, evidenceDigest: digestBuffer(Buffer.from(canonicalJson(body))) };
}
