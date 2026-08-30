import { describe, expect, it } from 'vitest';
import {
  baselineFromState,
  isRecoverableProductionState,
  validateApprovalReason,
} from './promotionGateCli.js';
import type { ReleaseManifest } from '@agent/shared';

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

  it('accepts only a component-wise mix of the frozen baseline and immutable target for recovery', () => {
    const oldSha = 'c'.repeat(40);
    const oldDigest = `sha256:${'d'.repeat(64)}`;
    const baseline = {
      web: { sourceSha: oldSha, artifactDigest: oldDigest },
      api: { sourceSha: oldSha, artifactDigest: oldDigest },
      runtimeWorker: { sourceSha: oldSha, artifactDigest: oldDigest },
      acs: {
        sourceSha: oldSha,
        orchestratorArtifactDigest: oldDigest,
        sandboxImageDigest: oldDigest,
      },
    };
    const manifest = {
      productionBaseline: baseline,
      components: {
        web: { sourceSha: SHA, artifactDigest: DIGEST },
        api: { sourceSha: SHA, artifactDigest: DIGEST },
        runtimeWorker: { sourceSha: SHA, artifactDigest: DIGEST },
        acs: {
          sourceSha: SHA,
          orchestratorArtifactDigest: DIGEST,
          sandboxImageDigest: DIGEST,
        },
      },
    } as ReleaseManifest;
    const partial = {
      components: {
        web: { gitSha: oldSha, artifactDigest: oldDigest },
        api: { gitSha: SHA, artifactDigest: DIGEST },
        runtimeWorker: { gitSha: SHA, artifactDigest: DIGEST },
        acs: {
          gitSha: SHA,
          orchestratorArtifactDigest: DIGEST,
          sandboxImageDigest: DIGEST,
        },
      },
    };
    expect(isRecoverableProductionState(partial, manifest)).toBe(true);
    partial.components.web = { gitSha: 'e'.repeat(40), artifactDigest: oldDigest };
    expect(isRecoverableProductionState(partial, manifest)).toBe(false);
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
