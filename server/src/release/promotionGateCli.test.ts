import { describe, expect, it } from 'vitest';
import {
  baselineFromState,
  parseProductionState,
  productionStateMatchesManifestPrefix,
  validateApprovalReason,
} from './promotionGateCli.js';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

describe('promotion gate evidence', () => {
  it('projects only immutable component identity from production observations', () => {
    const component = { gitSha: SHA, artifactDigest: DIGEST, deployedAt: 'ignored' };
    expect(
      baselineFromState({
        components: {
          web: component,
          api: component,
          runtimeWorker: component,
          acs: {
            gitSha: SHA,
            orchestratorArtifactDigest: DIGEST,
            sandboxImageDigest: DIGEST,
          },
        },
      }),
    ).toEqual({
      web: { sourceSha: SHA, artifactDigest: DIGEST },
      api: { sourceSha: SHA, artifactDigest: DIGEST },
      runtimeWorker: { sourceSha: SHA, artifactDigest: DIGEST },
      acs: {
        sourceSha: SHA,
        orchestratorArtifactDigest: DIGEST,
        sandboxImageDigest: DIGEST,
      },
    });
  });

  it('runtime-parses the production state before comparing a promotion baseline', () => {
    const component = { gitSha: SHA, artifactDigest: DIGEST };
    const valid = {
      components: {
        web: component,
        api: component,
        runtimeWorker: component,
        acs: {
          gitSha: SHA,
          orchestratorArtifactDigest: DIGEST,
          sandboxImageDigest: DIGEST,
        },
      },
    };
    expect(parseProductionState(valid)).toEqual(valid);
    expect(() =>
      parseProductionState({
        ...valid,
        components: {
          ...valid.components,
          runtimeWorker: { gitSha: SHA, artifactDigest: 'sha256:tampered' },
        },
      }),
    ).toThrow();
  });

  it('accepts exactly the ACS → App → Web prefixes for resumable production', () => {
    const baselineSha = 'c'.repeat(40);
    const targetSha = 'd'.repeat(40);
    const baselineDigest = `sha256:${'e'.repeat(64)}`;
    const targetDigest = `sha256:${'f'.repeat(64)}`;
    const matrix = (gitSha: string, artifactDigest: string) => ({
      web: { sourceSha: gitSha, artifactDigest },
      api: { sourceSha: gitSha, artifactDigest },
      runtimeWorker: { sourceSha: gitSha, artifactDigest },
      acs: {
        sourceSha: gitSha,
        orchestratorArtifactDigest: artifactDigest,
        sandboxImageDigest: artifactDigest,
      },
    });
    const manifest = {
      productionBaseline: matrix(baselineSha, baselineDigest),
      components: {
        ...matrix(targetSha, targetDigest),
        web: { ...matrix(targetSha, targetDigest).web, action: 'deploy' as const },
        api: { ...matrix(targetSha, targetDigest).api, action: 'deploy' as const },
        runtimeWorker: {
          ...matrix(targetSha, targetDigest).runtimeWorker,
          action: 'deploy' as const,
        },
        acs: { ...matrix(targetSha, targetDigest).acs, action: 'deploy' as const },
      },
    };
    const state = (components: ReturnType<typeof matrix>) => ({
      components: {
        web: { gitSha: components.web.sourceSha, artifactDigest: components.web.artifactDigest },
        api: { gitSha: components.api.sourceSha, artifactDigest: components.api.artifactDigest },
        runtimeWorker: {
          gitSha: components.runtimeWorker.sourceSha,
          artifactDigest: components.runtimeWorker.artifactDigest,
        },
        acs: {
          gitSha: components.acs.sourceSha,
          orchestratorArtifactDigest: components.acs.orchestratorArtifactDigest,
          sandboxImageDigest: components.acs.sandboxImageDigest,
        },
      },
    });

    const baseline = matrix(baselineSha, baselineDigest);
    const afterAcs = structuredClone(baseline);
    afterAcs.acs = matrix(targetSha, targetDigest).acs;
    const afterApp = structuredClone(afterAcs);
    afterApp.api = matrix(targetSha, targetDigest).api;
    afterApp.runtimeWorker = matrix(targetSha, targetDigest).runtimeWorker;
    const fullTarget = matrix(targetSha, targetDigest);
    for (const prefix of [baseline, afterAcs, afterApp, fullTarget]) {
      expect(productionStateMatchesManifestPrefix(manifest, state(prefix))).toBe(true);
    }

    const skippedAcs = structuredClone(baseline);
    skippedAcs.api = matrix(targetSha, targetDigest).api;
    skippedAcs.runtimeWorker = matrix(targetSha, targetDigest).runtimeWorker;
    expect(productionStateMatchesManifestPrefix(manifest, state(skippedAcs))).toBe(false);
    const drifted = structuredClone(afterAcs);
    drifted.web.sourceSha = '9'.repeat(40);
    expect(productionStateMatchesManifestPrefix(manifest, state(drifted))).toBe(false);
  });

  it('requires structured approval bound to the exact release and Manifest', () => {
    const verificationSummary = {
      schemaVersion: 1,
      mode: 'deterministic-deployment-gates-v1',
      status: 'passed',
      checks: [
        'immutable-artifacts',
        'runtime-identity',
        'api-readiness',
        'acs-health',
        'web-readback',
        'migration-readback',
        'reverse-isolation',
      ],
    };
    const valid = JSON.stringify({
      releaseId: 'rc-20260826-01',
      manifestDigest: DIGEST,
      stagingDeploymentId: '1',
      stagingRunId: '2',
      triggeredAt: '2026-08-26T00:00:00.000Z',
      reason: '测试人员与验收 Agent 已核对预览环境，可以晋级。',
      verificationSummary,
    });
    expect(
      validateApprovalReason(valid, { releaseId: 'rc-20260826-01', digest: DIGEST }),
    ).toMatchObject({
      stagingRunId: '2',
    });
    expect(() =>
      validateApprovalReason(valid, { releaseId: 'rc-20260826-02', digest: DIGEST }),
    ).toThrow(/not bound/u);
    expect(() =>
      validateApprovalReason('{}', { releaseId: 'rc-20260826-01', digest: DIGEST }),
    ).toThrow(/missing releaseId/u);
    expect(() =>
      validateApprovalReason(
        JSON.stringify({ ...JSON.parse(valid), verificationSummary: undefined }),
        { releaseId: 'rc-20260826-01', digest: DIGEST },
      ),
    ).toThrow(/deterministic Staging verification/u);
  });
});
