import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { calculateManifestDigest, ReleaseManifestStore } from './releaseManifestStore.js';

const SHA = 'a'.repeat(40);
const BASELINE = 'b'.repeat(40);
const SERVER_DIGEST = `sha256:${'c'.repeat(64)}`;
const WEB_DIGEST = `sha256:${'d'.repeat(64)}`;
const ACS_BUNDLE_DIGEST = `sha256:${'e'.repeat(64)}`;
const ACS_IMAGE_DIGEST = `sha256:${'f'.repeat(64)}`;

function matrix() {
  return {
    web: { sourceSha: BASELINE, artifactDigest: WEB_DIGEST },
    api: { sourceSha: BASELINE, artifactDigest: SERVER_DIGEST },
    runtimeWorker: { sourceSha: BASELINE, artifactDigest: SERVER_DIGEST },
    acs: {
      sourceSha: BASELINE,
      orchestratorArtifactDigest: ACS_BUNDLE_DIGEST,
      sandboxImageDigest: ACS_IMAGE_DIGEST,
    },
  };
}

function manifestFor(releaseId = 'rc-20260825-01') {
  const productionBaseline = matrix();
  const unsigned = {
    schemaVersion: 1 as const,
    releaseId,
    releaseSha: SHA,
    tag: releaseId,
    createdAt: '2026-08-25T08:00:00.000Z',
    createdBy: 'test',
    releasePullRequest: {
      number: 183,
      headSha: 'c'.repeat(40),
      mergeCommitOid: SHA,
      state: 'MERGED' as const,
    },
    integrationCandidates: [],
    sourcePullRequests: [183],
    productionBaseline,
    components: {
      web: { action: 'deploy' as const, sourceSha: SHA, artifactDigest: WEB_DIGEST },
      api: { action: 'deploy' as const, sourceSha: SHA, artifactDigest: SERVER_DIGEST },
      runtimeWorker: { action: 'deploy' as const, sourceSha: SHA, artifactDigest: SERVER_DIGEST },
      acs: { action: 'keep' as const, ...productionBaseline.acs },
    },
    artifacts: {
      serverBundle: {
        uri: 'oss://release-records/releases/server.tgz',
        digest: SERVER_DIGEST,
        size: 123,
      },
      webAssets: { uri: 'oss://release-records/releases/web.tgz', digest: WEB_DIGEST, size: 456 },
      acsOrchestrator: {
        required: false,
        uri: 'oss://release-records/releases/acs.tgz',
        digest: ACS_BUNDLE_DIGEST,
        size: 789,
      },
      acsImage: { required: false, repository: 'agent-saas/acs-sandbox', digest: ACS_IMAGE_DIGEST },
    },
    checks: {
      appCi: { status: 'success' as const, headSha: SHA, runId: 123 },
      acsImpact: { status: 'not_required' as const, headSha: SHA },
      mergeReceipt: { status: 'success' as const, subjectDigest: SERVER_DIGEST },
    },
    promotionPolicy: {
      expiresAt: '2026-09-01T08:00:00.000Z',
      minimumPromotableSha: BASELINE,
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
  return { ...unsigned, digest: calculateManifestDigest(unsigned) };
}

describe('ReleaseManifestStore', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('creates and reads a digest-verified canonical manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-manifest-'));
    directories.push(root);
    const store = new ReleaseManifestStore(root);
    const created = await store.create(manifestFor());
    expect(created.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(store.read('rc-20260825-01')).resolves.toEqual(created);
  });

  it('refuses to overwrite an existing manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-manifest-'));
    directories.push(root);
    const store = new ReleaseManifestStore(root);
    await store.create(manifestFor());
    await expect(store.create(manifestFor())).rejects.toThrow(/immutable/);
  });

  it('rejects a digest mismatch both before write and on read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-manifest-'));
    directories.push(root);
    const store = new ReleaseManifestStore(root);
    await expect(
      store.create({ ...manifestFor(), digest: `sha256:${'0'.repeat(64)}` }),
    ).rejects.toThrow(/digest/);
    const good = manifestFor();
    await writeFile(
      join(root, 'rc-20260825-01.json'),
      JSON.stringify({
        ...good,
        artifacts: {
          ...good.artifacts,
          webAssets: {
            ...good.artifacts.webAssets,
            uri: 'oss://release-records/releases/tampered.tgz',
          },
        },
      }),
    );
    await expect(store.read('rc-20260825-01')).rejects.toThrow(/digest/);
  });
});
