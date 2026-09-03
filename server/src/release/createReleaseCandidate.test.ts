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
const RUNTIME_ARTIFACT = `sha256:${'8'.repeat(64)}`;
const DEPENDENCY = `sha256:${'9'.repeat(64)}`;
const CONTRACT = `sha256:${'a'.repeat(64)}`;
const IDENTITY = `sha256:${'b'.repeat(64)}`;
const BASE_SERVER_RUNTIME = `sha256:${'c'.repeat(64)}`;
const BASE_ACS_RUNTIME = `sha256:${'d'.repeat(64)}`;
const CHANGED_ORCH = `sha256:${'e'.repeat(64)}`;
const CHANGED_IMAGE = `sha256:${'f'.repeat(64)}`;

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
    releasePullRequest: {
      number: 201,
      headSha: 'c'.repeat(40),
      mergeCommitOid: SHA,
      state: 'MERGED',
    },
    integrationCandidates: [],
    sourcePullRequests: [201],
    checks: {
      appCi: { status: 'success', headSha: SHA, runId: 100 },
      acsImpact: { status: 'success', headSha: SHA, runId: 101 },
      mergeReceipt: { status: 'success', subjectDigest: `sha256:${'6'.repeat(64)}` },
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
      runtimeDependencies: {
        uri: 'oss://agent-saas-releases/runtime-dependencies.json',
        digest: RUNTIME_ARTIFACT,
        size: 10,
        sourceSha: SHA,
        identityDigest: IDENTITY,
        dependencyDigest: DEPENDENCY,
        contractDigest: CONTRACT,
      },
      acsOrchestrator: {
        uri: 'oss://agent-saas-releases/acs.tgz',
        digest: CHANGED_ORCH,
        size: 10,
      },
      acsImage: { repository: 'registry/acs', digest: CHANGED_IMAGE },
    },
    baselineArtifacts: {
      serverBundle: { uri: 'oss://agent-saas-releases/base-server.tgz', digest: SERVER, size: 10 },
      webAssets: { uri: 'oss://agent-saas-releases/base-web.tgz', digest: WEB, size: 10 },
      runtimeDependencies: {
        server: {
          uri: 'oss://agent-saas-releases/base-server-runtime.json',
          digest: BASE_SERVER_RUNTIME,
          size: 10,
          sourceSha: BASE,
          identityDigest: `sha256:${'1'.repeat(64)}`,
          dependencyDigest: `sha256:${'2'.repeat(64)}`,
          contractDigest: `sha256:${'3'.repeat(64)}`,
        },
        acs: {
          uri: 'oss://agent-saas-releases/base-acs-runtime.json',
          digest: BASE_ACS_RUNTIME,
          size: 10,
          sourceSha: BASE,
          identityDigest: `sha256:${'4'.repeat(64)}`,
          dependencyDigest: `sha256:${'5'.repeat(64)}`,
          contractDigest: `sha256:${'6'.repeat(64)}`,
        },
      },
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
  // v2 必须绑定实际选中 artifact 的 Runtime identity，未选中的基线无需阻塞首次全量部署。
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
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.artifacts.acsOrchestrator.required).toBe(false);
    expect(manifest.artifacts.runtimeDependencies.server.sourceSha).toBe(SHA);
    expect(manifest.artifacts.runtimeDependencies.acs.sourceSha).toBe(BASE);
  });

  it.each([
    {
      name: 'web-only',
      affected: ['web'] as ReleaseCandidateEvidence['affectedComponents'],
      serverSha: BASE,
      acsSha: BASE,
      serverRuntimeDigest: BASE_SERVER_RUNTIME,
      acsRuntimeDigest: BASE_ACS_RUNTIME,
    },
    {
      name: 'app-only',
      affected: ['api', 'runtimeWorker'] as ReleaseCandidateEvidence['affectedComponents'],
      serverSha: SHA,
      acsSha: BASE,
      serverRuntimeDigest: RUNTIME_ARTIFACT,
      acsRuntimeDigest: BASE_ACS_RUNTIME,
    },
    {
      name: 'ACS-only',
      affected: ['acs'] as ReleaseCandidateEvidence['affectedComponents'],
      serverSha: BASE,
      acsSha: SHA,
      serverRuntimeDigest: BASE_SERVER_RUNTIME,
      acsRuntimeDigest: RUNTIME_ARTIFACT,
    },
  ])(
    'selects component-scoped runtime identities for $name',
    ({ affected, serverSha, acsSha, serverRuntimeDigest, acsRuntimeDigest }) => {
      const input = evidence();
      input.affectedComponents = affected;
      const manifest = createReleaseCandidate(input);
      expect(manifest.artifacts.runtimeDependencies.server).toMatchObject({
        sourceSha: serverSha,
        digest: serverRuntimeDigest,
      });
      expect(manifest.artifacts.runtimeDependencies.acs).toMatchObject({
        sourceSha: acsSha,
        digest: acsRuntimeDigest,
      });
      expect(validateManifest(manifest)).toEqual(manifest);
    },
  );

  it('requires baseline Runtime identities only for components selected as keep', () => {
    const fullDeploy = evidence();
    fullDeploy.affectedComponents = ['api', 'runtimeWorker', 'acs'];
    delete fullDeploy.baselineArtifacts.runtimeDependencies.server;
    delete fullDeploy.baselineArtifacts.runtimeDependencies.acs;
    expect(() => createReleaseCandidate(fullDeploy)).not.toThrow();

    const keptServer = evidence();
    keptServer.affectedComponents = ['web'];
    delete keptServer.baselineArtifacts.runtimeDependencies.server;
    expect(() => createReleaseCandidate(keptServer)).toThrow(
      'A kept Server requires its baseline Runtime Dependency Identity',
    );

    const keptAcs = evidence();
    keptAcs.affectedComponents = ['api', 'runtimeWorker'];
    delete keptAcs.baselineArtifacts.runtimeDependencies.acs;
    expect(() => createReleaseCandidate(keptAcs)).toThrow(
      'A kept ACS requires its baseline Runtime Dependency Identity',
    );
  });

  it('rejects API and Worker action divergence', () => {
    const input = evidence();
    input.affectedComponents = ['api'];
    expect(() => createReleaseCandidate(input)).toThrow(/must deploy or keep together/u);
  });

  it('rejects ACS deploy without exact orchestrator and image artifacts', () => {
    const input = evidence();
    input.affectedComponents = ['acs'];
    delete input.builtArtifacts.acsOrchestrator;
    expect(() => createReleaseCandidate(input)).toThrow(/exact immutable artifacts/u);
  });
});
