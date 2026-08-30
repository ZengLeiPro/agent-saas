import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  releaseManifestContentSchema,
  releaseManifestSchema,
} from './releaseManifest';

const RELEASE_SHA = 'a'.repeat(40);
const BASELINE_SHA = 'b'.repeat(40);
const SERVER_DIGEST = `sha256:${'c'.repeat(64)}`;
const WEB_DIGEST = `sha256:${'d'.repeat(64)}`;
const ACS_BUNDLE_DIGEST = `sha256:${'e'.repeat(64)}`;
const ACS_IMAGE_DIGEST = `sha256:${'f'.repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${'0'.repeat(64)}`;

function matrix(sha = BASELINE_SHA) {
  return {
    web: { sourceSha: sha, artifactDigest: WEB_DIGEST },
    api: { sourceSha: sha, artifactDigest: SERVER_DIGEST },
    runtimeWorker: { sourceSha: sha, artifactDigest: SERVER_DIGEST },
    acs: {
      sourceSha: sha,
      orchestratorArtifactDigest: ACS_BUNDLE_DIGEST,
      sandboxImageDigest: ACS_IMAGE_DIGEST,
    },
  };
}

export function validManifestContent() {
  const productionBaseline = matrix();
  return {
    schemaVersion: 2 as const,
    releaseId: 'rc-20260825-01',
    releaseSha: RELEASE_SHA,
    tag: 'rc-20260825-01',
    createdAt: '2026-08-25T08:00:00.000Z',
    createdBy: 'github-actions',
    releasePullRequest: {
      number: 194,
      headSha: 'c'.repeat(40),
      mergeCommitOid: RELEASE_SHA,
      state: 'MERGED' as const,
    },
    integrationCandidates: [],
    sourcePullRequests: [194],
    productionBaseline,
    components: {
      web: { action: 'deploy' as const, sourceSha: RELEASE_SHA, artifactDigest: WEB_DIGEST },
      api: { action: 'deploy' as const, sourceSha: RELEASE_SHA, artifactDigest: SERVER_DIGEST },
      runtimeWorker: {
        action: 'deploy' as const,
        sourceSha: RELEASE_SHA,
        artifactDigest: SERVER_DIGEST,
      },
      acs: { action: 'keep' as const, ...productionBaseline.acs },
    },
    artifacts: {
      serverBundle: {
        uri: 'oss://release-records/releases/server.tgz',
        digest: SERVER_DIGEST,
        size: 123,
      },
      webAssets: { uri: 'oss://release-records/releases/web.tgz', digest: WEB_DIGEST, size: 456 },
      runtimeDependencies: {
        server: {
          uri: 'oss://release-records/releases/runtime-dependencies.json',
          digest: `sha256:${'8'.repeat(64)}`,
          size: 512,
          sourceSha: RELEASE_SHA,
          identityDigest: `sha256:${'9'.repeat(64)}`,
          dependencyDigest: `sha256:${'a'.repeat(64)}`,
          contractDigest: `sha256:${'b'.repeat(64)}`,
        },
        acs: {
          uri: 'oss://release-records/baseline/acs-runtime-dependencies.json',
          digest: `sha256:${'c'.repeat(64)}`,
          size: 513,
          sourceSha: BASELINE_SHA,
          identityDigest: `sha256:${'d'.repeat(64)}`,
          dependencyDigest: `sha256:${'e'.repeat(64)}`,
          contractDigest: `sha256:${'f'.repeat(64)}`,
        },
      },
      acsOrchestrator: {
        required: false,
        uri: 'oss://release-records/releases/acs.tgz',
        digest: ACS_BUNDLE_DIGEST,
        size: 789,
      },
      acsImage: { required: false, repository: 'agent-saas/acs-sandbox', digest: ACS_IMAGE_DIGEST },
    },
    checks: {
      appCi: { status: 'success' as const, headSha: RELEASE_SHA, runId: 123 },
      acsImpact: { status: 'not_required' as const, headSha: RELEASE_SHA },
      mergeReceipt: { status: 'success' as const, subjectDigest: SERVER_DIGEST },
    },
    promotionPolicy: {
      expiresAt: '2026-09-01T08:00:00.000Z',
      minimumPromotableSha: BASELINE_SHA,
      requiresHumanApproval: true as const,
    },
    migrationPlan: {
      phase: 'none' as const,
      planDigest: `sha256:${'7'.repeat(64)}`,
      confirmation: 'not_required' as const,
      contract: 'separate_release' as const,
    },
    rollbackTargets: matrix(),
  };
}

function validLegacyManifestContent(): Record<string, any> {
  const legacy = structuredClone(validManifestContent()) as Record<string, any>;
  legacy.schemaVersion = 1;
  delete legacy.artifacts.runtimeDependencies;
  return legacy;
}

describe('releaseManifestSchema', () => {
  it('accepts the complete component, evidence, policy, artifact, and rollback contract', () => {
    expect(
      releaseManifestSchema.safeParse({ ...validManifestContent(), digest: MANIFEST_DIGEST })
        .success,
    ).toBe(true);
  });

  it('strictly accepts immutable legacy v1 without treating v2 fields as optional', () => {
    const legacy = validLegacyManifestContent();
    expect(releaseManifestContentSchema.safeParse(legacy).success).toBe(true);
    legacy.artifacts.runtimeDependencies = validManifestContent().artifacts.runtimeDependencies;
    expect(releaseManifestContentSchema.safeParse(legacy).success).toBe(false);
  });

  it('rejects incomplete SHAs, unsafe artifact URIs, and unsorted PR evidence', () => {
    expect(
      releaseManifestContentSchema.safeParse({ ...validManifestContent(), releaseSha: 'abc123' })
        .success,
    ).toBe(false);
    const unsafe = validManifestContent();
    unsafe.artifacts.webAssets.uri = 'https://user:password@example.test/web.tgz?signature=secret';
    expect(releaseManifestContentSchema.safeParse(unsafe).success).toBe(false);
    expect(
      releaseManifestContentSchema.safeParse({
        ...validManifestContent(),
        sourcePullRequests: [194, 183],
      }).success,
    ).toBe(false);
  });

  it('requires traceable GitHub merge evidence and coherent ACS check receipts', () => {
    const missingMerge = validManifestContent();
    delete (missingMerge as Partial<typeof missingMerge>).releasePullRequest;
    delete (missingMerge.checks as Partial<typeof missingMerge.checks>).mergeReceipt;
    expect(releaseManifestContentSchema.safeParse(missingMerge).success).toBe(false);
    const inconsistent = validManifestContent();
    (inconsistent.checks as unknown as Record<string, unknown>).acsImpact = {
      status: 'success',
      headSha: RELEASE_SHA,
    };
    expect(releaseManifestContentSchema.safeParse(inconsistent).success).toBe(false);
  });

  it('continues to accept immutable legacy Taskboard Integration manifests', () => {
    const legacy = validManifestContent() as Record<string, any>;
    delete legacy.releasePullRequest;
    legacy.integrationCandidates = [
      {
        candidateId: '85a9cb68-4130-4c0a-aec3-e4cc9c671bd5',
        revision: 2,
        mergedCommitOid: RELEASE_SHA,
      },
    ];
    legacy.checks.integrationReceipt = legacy.checks.mergeReceipt;
    delete legacy.checks.mergeReceipt;
    legacy.promotionPolicy.appAcsCompatibility = 'n_and_n_plus_1';
    legacy.promotionPolicy.compatibilityEvidenceDigest = `sha256:${'8'.repeat(64)}`;
    expect(releaseManifestContentSchema.safeParse(legacy).success).toBe(true);
  });

  it('binds deploy and keep source identities to release and baseline', () => {
    const deploy = validManifestContent();
    deploy.components.web.sourceSha = BASELINE_SHA;
    expect(releaseManifestContentSchema.safeParse(deploy).success).toBe(false);

    const keep = validManifestContent();
    keep.components.acs.sandboxImageDigest = MANIFEST_DIGEST;
    expect(releaseManifestContentSchema.safeParse(keep).success).toBe(false);
  });

  it('binds each v2 runtime identity to the selected component source', () => {
    const manifest = validManifestContent();
    manifest.artifacts.runtimeDependencies.acs.sourceSha = RELEASE_SHA;
    expect(releaseManifestContentSchema.safeParse(manifest).success).toBe(false);
  });

  it('binds both ACS digests and App digests to immutable artifacts', () => {
    const manifest = validManifestContent();
    manifest.components.acs.orchestratorArtifactDigest = MANIFEST_DIGEST;
    expect(releaseManifestContentSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects a mixed API and Runtime Worker action matrix for one server bundle', () => {
    const manifest = validManifestContent();
    const runtimeWorker = manifest.components.runtimeWorker as {
      action: 'deploy' | 'keep';
      sourceSha: string;
      artifactDigest: string;
    };
    Object.assign(runtimeWorker, {
      action: 'keep',
      ...manifest.productionBaseline.runtimeWorker,
    });
    expect(releaseManifestContentSchema.safeParse(manifest).success).toBe(false);
  });

  it('requires rollback targets to equal the frozen production baseline', () => {
    const manifest = validManifestContent();
    manifest.rollbackTargets.web.sourceSha = RELEASE_SHA;
    expect(releaseManifestContentSchema.safeParse(manifest).success).toBe(false);
  });

  it('requires expand migrations to be confirmed after observation and keeps contract separate', () => {
    const invalid = {
      ...validManifestContent(),
      migrationPlan: {
        ...validManifestContent().migrationPlan,
        phase: 'expand',
        confirmation: 'not_required',
      },
    };
    expect(releaseManifestContentSchema.safeParse(invalid).success).toBe(false);

    invalid.migrationPlan.confirmation = 'required_after_observation';
    expect(releaseManifestContentSchema.safeParse(invalid).success).toBe(true);
  });
});

describe('canonicalJson', () => {
  it('recursively sorts object keys, preserves arrays, and normalizes negative zero', () => {
    expect(canonicalJson({ z: { b: 2, a: -0 }, a: [{ y: 2, x: 1 }, 'first', 'second'] })).toBe(
      '{"a":[{"x":1,"y":2},"first","second"],"z":{"a":0,"b":2}}',
    );
  });

  it('rejects values which JSON would silently coerce', () => {
    expect(() => canonicalJson({ number: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ missing: undefined })).toThrow(TypeError);
  });
});
